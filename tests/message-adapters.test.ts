import { expect, test } from "bun:test";
import type { Endpoint, Notification } from "../src/messages/contracts.ts";
import {
  createT3Adapter,
  resolveT3Thread,
  T3_DEFAULT_RETRY_MS,
  T3_DIAGNOSTICS,
  T3_MAX_NOTIFICATION_ID_LENGTH,
  T3_MAX_RETRY_MS,
  T3_MAX_TIMEOUT_MS,
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
      if (outcome?.status === "accepted" && !delivered.has(input.requestId)) delivered.set(input.requestId, input);
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

test("host failures are classified by kind, never thrown, and recover", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const run = (error: unknown) => {
    host.set(() => {
      throw error;
    });
    return adapter.notify(note());
  };
  expect(await run(new T3TransportError("unavailable", "connection refused"))).toMatchObject({ status: "deferred", detail: T3_DIAGNOSTICS.unavailable });
  expect(await run(new T3TransportError("unauthenticated", "token expired"))).toMatchObject({ status: "deferred", detail: T3_DIAGNOSTICS.unauthenticated });
  expect(await run(new T3TransportError("unknown_thread", "no such thread"))).toEqual({ status: "unsupported", detail: T3_DIAGNOSTICS.unknownThread });
  expect(await run(new T3TransportError("rejected", "mode ceiling"))).toEqual({ status: "unsupported", detail: T3_DIAGNOSTICS.rejected });
  expect(await run(new Error("plain"))).toMatchObject({ status: "deferred", detail: T3_DIAGNOSTICS.routeFailed });
  host.set(() => ({ status: "accepted" })); // host back: same adapter recovers
  expect(await adapter.notify(note())).toEqual({ status: "sent" });
});

const DIAGNOSES = new Set<string>(Object.values(T3_DIAGNOSTICS));
const expectFixedDiagnosis = (result: { detail?: string }) => {
  expect(DIAGNOSES.has(result.detail ?? "")).toBe(true);
};

test("A1: no credential form from errors, strings, bodies or fields reaches a diagnosis", async () => {
  const secrets = [
    "Authorization: Bearer abc.def.ghi",
    "Authorization: Basic dXNlcjpwYXNz",
    "cookie: t3_session=SEKRET456",
    "GET http://127.0.0.1:1/mcp?access_token=SEKRET123 failed",
    "token=eyJhbGciOi.eyJzdWIi.c2ln",
  ];
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const throwables: unknown[] = [];
  for (const secret of secrets) {
    throwables.push(new Error(secret), new T3TransportError("unavailable", secret), secret, { body: secret, message: secret });
    for (const kind of ["unavailable", "unauthenticated", "unknown_thread", "rejected"] as const) throwables.push(new T3TransportError(kind, secret));
  }
  for (const thrown of throwables) {
    host.set(() => {
      throw thrown;
    });
    const result = await adapter.notify(note());
    expectFixedDiagnosis(result);
    expect(JSON.stringify(result)).not.toMatch(/SEKRET|abc\.def|dXNlcjpw|eyJ/);
  }
  // Rejected promise and secret-bearing outcome object take the same fixed paths.
  host.set(() => Promise.reject(new Error(secrets[0])));
  expectFixedDiagnosis(await adapter.notify(note()));
  host.set(() => ({ status: "accepted", detail: secrets[1], error: secrets[2] }) as T3SendOutcome);
  expect(await adapter.notify(note())).toEqual({ status: "sent" });
  host.set(() => ({ status: secrets[3] }) as unknown as T3SendOutcome);
  const odd = await adapter.notify(note());
  expectFixedDiagnosis(odd);
  expect(odd.detail).not.toContain("SEKRET");
});

test("A2: hostile thrown values and getters still produce a deferred result", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const hostile: unknown[] = [
    Object.create(null),
    { toString() { throw new Error("toString"); } },
    Object.defineProperty(new Error("x"), "message", { get() { throw new Error("getter"); } }),
    Object.defineProperty(new T3TransportError("unavailable", "x"), "kind", { get() { throw new Error("kind getter"); } }),
    new Proxy({}, { getPrototypeOf() { throw new Error("proxy"); }, get() { throw new Error("proxy get"); } }),
    undefined,
    null,
    Symbol("s"),
  ];
  for (const thrown of hostile) {
    host.set(() => {
      throw thrown;
    });
    const result = await adapter.notify(note());
    expect(result.status).toBe("deferred");
    expectFixedDiagnosis(result);
  }
  // Hostile capabilities and hostile notification fields never reject either.
  const getterHost: T3Transport = {
    get capabilities(): T3Capabilities {
      throw new Error("caps");
    },
    send: async () => ({ status: "accepted" }),
  };
  expect((await createT3Adapter({ transport: getterHost }).notify(note())).status).toBe("deferred");
  const hostileEndpoint = note({ endpoint: new Proxy({} as Endpoint, { get() { throw new Error("endpoint"); } }) });
  expect((await adapter.notify(hostileEndpoint)).status).toBe("unsupported");
  expect((await adapter.notify(null as unknown as Notification)).status).toBe("deferred");
});

test("A3: malformed timeout/retry config is rejected before any host call; valid bounds work", async () => {
  const host = fakeHost();
  const bad = [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, 2 ** 31, 1e12, T3_MAX_TIMEOUT_MS + 1];
  for (const value of bad) {
    expect(() => createT3Adapter({ transport: host.transport, timeoutMs: value })).toThrow(/timeoutMs/);
  }
  for (const value of [Number.NaN, -5, 0, 0.5, Number.POSITIVE_INFINITY, T3_MAX_RETRY_MS + 1]) {
    expect(() => createT3Adapter({ transport: host.transport, retryAfterMs: value })).toThrow(/retryAfterMs/);
  }
  expect(host.calls).toHaveLength(0);
  const edge = createT3Adapter({ transport: host.transport, timeoutMs: T3_MAX_TIMEOUT_MS, retryAfterMs: T3_MAX_RETRY_MS });
  host.set(() => ({ status: "pending_request" }));
  expect(await edge.notify(note())).toMatchObject({ status: "deferred", retryAfterMs: T3_MAX_RETRY_MS });
  const defaults = await createT3Adapter({ transport: host.transport }).notify(note());
  expect(defaults.retryAfterMs).toBe(T3_DEFAULT_RETRY_MS);
});

test("A4: unknown or malformed host outcomes are a generic retryable protocol error, never a fake pending question", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const outcomes: unknown[] = [{ status: "bogus" }, undefined, null, "accepted", 7, {}, { status: "ACCEPTED" }, { status: undefined }];
  for (const outcome of outcomes) {
    host.set(() => outcome as T3SendOutcome);
    const result = await adapter.notify(note());
    expect(result).toMatchObject({ status: "deferred", detail: T3_DIAGNOSTICS.unknownOutcome });
    expect(result.detail).not.toBe(T3_DIAGNOSTICS.pendingQuestion);
  }
  expect(host.delivered.size).toBe(0);
  host.set(() => ({ get status(): string { throw new Error("status getter"); } }) as unknown as T3SendOutcome);
  expectFixedDiagnosis(await adapter.notify(note()));
});

test("A5: diagnostics stay fixed and bounded for oversized or hostile endpoint values", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const huge = "x".repeat(5000);
  const endpoints: Endpoint[] = [
    { ...endpoint(), host: huge },
    { ...endpoint(), target: { threadId: huge } },
    { ...endpoint(), sessionId: huge },
  ];
  for (const e of endpoints) {
    const result = await adapter.notify(note({ endpoint: e }));
    expect(result.status).toBe("unsupported");
    expectFixedDiagnosis(result);
    expect(result.detail!.length).toBeLessThan(160);
  }
  // An oversized unrelated target field is ignored, not echoed.
  const extra = await adapter.notify(note({ endpoint: endpoint(THREAD_A, { extra: huge }) }));
  expect(extra).toEqual({ status: "sent" });
  expect(JSON.stringify(host.calls.at(-1))).not.toContain(huge);
  expect(Math.max(...[...DIAGNOSES].map((d) => d.length))).toBeLessThan(160);
  const reason = resolveT3Thread(note({ endpoint: { ...endpoint(), host: huge } }));
  expect(reason).toEqual({ reason: T3_DIAGNOSTICS.badHost });
});

test("A6: a usable notificationId is required before any send", async () => {
  const host = fakeHost();
  const adapter = createT3Adapter({ transport: host.transport });
  const bad: unknown[] = ["", "x".repeat(T3_MAX_NOTIFICATION_ID_LENGTH + 1), undefined, null, 42, {}];
  for (const notificationId of bad) {
    const result = await adapter.notify(note({ notificationId: notificationId as string }));
    expect(result).toEqual({ status: "unsupported", detail: T3_DIAGNOSTICS.badNotificationId });
  }
  expect(host.calls).toHaveLength(0);
  expect(await adapter.notify(note({ notificationId: "x".repeat(T3_MAX_NOTIFICATION_ID_LENGTH) }))).toEqual({ status: "sent" });
  expect(host.calls).toHaveLength(1);
});

test("capability flags must be exactly true, not merely truthy", async () => {
  const host = fakeHost({ stableRequestId: "yes", pendingSafeSend: 1 } as unknown as T3Capabilities);
  const result = await createT3Adapter({ transport: host.transport }).notify(note());
  expect(result.status).toBe("unsupported");
  expect(host.calls).toHaveLength(0);
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
