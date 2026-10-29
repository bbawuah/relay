import { expect, test } from "bun:test";
import type { Endpoint, Notification } from "../src/messages/contracts.ts";
import {
  createT3Adapter,
  resolveT3Thread,
  t3NotificationText,
  t3RequestId,
  T3TransportError,
  type T3Capabilities,
  type T3SendInput,
  type T3SendOutcome,
  type T3Transport,
} from "../src/adapters/index.ts";

const THREAD_A = "01a17ebe-4fe1-79b1-807b-0e8515a20120";
const THREAD_B = "01a17ebe-4fe1-79b1-807b-0e8515a20121";
const PROVEN: T3Capabilities = { stableRequestId: true, pendingSafeSend: true };

const endpoint = (threadId = THREAD_A, extra: Record<string, string> = {}): Endpoint => ({
  host: "t3",
  sessionId: threadId,
  generation: 1,
  target: { threadId, ...extra },
});
const note = (over: Partial<Notification> = {}): Notification => ({
  notificationId: "job-1",
  namespace: "ns",
  peerId: "peer-a",
  endpoint: endpoint(),
  unread: 2,
  ...over,
});

/** Isolated fake host: dedupes by request ID like T3's clientRequestId, records everything. */
function fakeHost(capabilities: T3Capabilities = PROVEN) {
  const calls: T3SendInput[] = [];
  const delivered = new Map<string, T3SendInput>();
  let behavior: (input: T3SendInput) => Promise<T3SendOutcome> | T3SendOutcome = () => ({ status: "accepted" });
  const transport: T3Transport = {
    capabilities,
    async send(input) {
      calls.push(input);
      const outcome = await behavior(input);
      if (outcome.status === "accepted" && !delivered.has(input.requestId)) delivered.set(input.requestId, input);
      return outcome;
    },
  };
  return { transport, calls, delivered, set: (b: typeof behavior) => (behavior = b) };
}

test("sends a count-only notice and never leaks bodies, senders or peer names", async () => {
  const host = fakeHost();
  const result = await createT3Adapter({ transport: host.transport }).notify(note({ unread: 3, peerId: "secret-peer-name" }));
  expect(result).toEqual({ status: "sent" });
  expect(host.calls).toHaveLength(1);
  expect(host.calls[0]!.threadId).toBe(THREAD_A);
  expect(host.calls[0]!.text).toBe(t3NotificationText(3));
  expect(host.calls[0]!.text).not.toContain("secret-peer-name");
  expect(host.calls[0]!.text).not.toContain("ns");
});

test("without a transport the adapter is unsupported and explains polling", async () => {
  const result = await createT3Adapter().notify(note());
  expect(result.status).toBe("unsupported");
  expect(result.detail).toContain("polled");
});

test("a route without a proven stable request ID or atomic pending guard is never used", async () => {
  // Shape of today's `t3 thread show` + `t3 thread send` route: racy and no request ID.
  for (const caps of [
    { stableRequestId: false, pendingSafeSend: true },
    { stableRequestId: true, pendingSafeSend: false },
    { stableRequestId: false, pendingSafeSend: false },
  ]) {
    const host = fakeHost(caps);
    const result = await createT3Adapter({ transport: host.transport }).notify(note());
    expect(result.status).toBe("unsupported");
    expect(host.calls).toHaveLength(0);
  }
});

test("a pending user question defers the notice and leaves it retryable", async () => {
  const host = fakeHost();
  host.set(() => ({ status: "pending_request" }));
  const adapter = createT3Adapter({ transport: host.transport, retryAfterMs: 1234 });
  expect(await adapter.notify(note())).toMatchObject({ status: "deferred", retryAfterMs: 1234 });
  expect(host.delivered.size).toBe(0);
  host.set(() => ({ status: "accepted" })); // question answered
  expect(await adapter.notify(note())).toEqual({ status: "sent" });
  expect(host.delivered.size).toBe(1);
});

test("request ID is stable per job, distinct across jobs and does not expose the job id", () => {
  expect(t3RequestId("job-1")).toBe(t3RequestId("job-1"));
  expect(t3RequestId("job-1")).not.toBe(t3RequestId("job-2"));
  expect(t3RequestId("job-1")).not.toContain("job-1");
});

test("lost reply: timeout defers, and the identical retry is one host delivery", async () => {
  const host = fakeHost();
  // Host accepts but the answer never arrives within the budget.
  host.set(async (input) => {
    host.delivered.set(input.requestId, input);
    return new Promise<T3SendOutcome>(() => {});
  });
  const adapter = createT3Adapter({ transport: host.transport, timeoutMs: 20 });
  const first = await adapter.notify(note());
  expect(first.status).toBe("deferred");
  expect(first.detail).toContain("retry is idempotent");
  expect(host.calls[0]!.signal.aborted).toBe(true);
  host.set(() => ({ status: "accepted" }));
  expect(await adapter.notify(note())).toEqual({ status: "sent" });
  expect(host.calls).toHaveLength(2);
  expect(host.calls[1]!.requestId).toBe(host.calls[0]!.requestId);
  expect(host.delivered.size).toBe(1);
});

test("host failures are classified, never thrown, and redact credentials", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const run = (error: unknown) => {
    host.set(() => {
      throw error;
    });
    return adapter.notify(note());
  };
  expect((await run(new T3TransportError("unavailable", "connection refused"))).status).toBe("deferred");
  expect((await run(new T3TransportError("unauthenticated", "token expired"))).status).toBe("deferred");
  expect((await run(new T3TransportError("unknown_thread", "no such thread"))).status).toBe("unsupported");
  expect((await run(new T3TransportError("rejected", "mode ceiling"))).status).toBe("unsupported");
  const crash = await run(new Error("boom Authorization: Bearer abc.def.ghi " + "x".repeat(500)));
  expect(crash.status).toBe("deferred");
  expect(crash.detail).not.toContain("abc.def.ghi");
  expect(crash.detail!.length).toBeLessThan(260);
  host.set(() => ({ status: "accepted" })); // host back: same adapter recovers
  expect(await adapter.notify(note())).toEqual({ status: "sent" });
});

test("two threads sharing a checkout and provider get separate, explicit bindings", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const shared = { cwd: "/same/checkout", provider: "codex" };
  await adapter.notify(note({ notificationId: "a", endpoint: endpoint(THREAD_A, shared) }));
  await adapter.notify(note({ notificationId: "b", endpoint: endpoint(THREAD_B, shared) }));
  expect(host.calls.map((c) => c.threadId)).toEqual([THREAD_A, THREAD_B]);
  expect(new Set(host.calls.map((c) => c.requestId)).size).toBe(2);
});

test("ambiguous or malformed bindings are refused instead of guessed", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const bad: Endpoint[] = [
    { ...endpoint(), host: "claude" },
    { ...endpoint(), sessionId: THREAD_B }, // session and thread disagree after a reconnect
    { ...endpoint(), target: { cwd: "/same/checkout" } }, // cwd alone never selects a thread
    endpoint("../../etc/passwd"),
    endpoint("a b; rm -rf /"),
    endpoint(""),
  ];
  for (const e of bad) expect((await adapter.notify(note({ endpoint: e }))).status).toBe("unsupported");
  expect(host.calls).toHaveLength(0);
  expect(resolveT3Thread(note())).toEqual({ threadId: THREAD_A });
});

test("nothing unread means nothing to send", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  for (const unread of [0, -1, 1.5, Number.NaN]) {
    expect((await adapter.notify(note({ unread }))).status).toBe("unsupported");
  }
  expect(host.calls).toHaveLength(0);
});
