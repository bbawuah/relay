import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMessageStore } from "../src/storage/store";
import { dispatchOnce } from "../src/dispatch/dispatcher";
import type { MessageAdapter, Notification } from "../src/messages/contracts";

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "relay-message-dispatch-"));
console.log(`Message dispatcher fixtures retained: ${scratch}`);
let seq = 0;
function fixture() {
  const dir = join(scratch, String(++seq)); mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, "messages.sqlite"); let time = 100;
  const now = () => time; const store = createMessageStore({ path, now });
  for (const id of ["alice", "bob"]) store.register({ id, namespace: "n", name: id,
    endpoint: { host: "fake", sessionId: id, generation: 1, target: { thread: id } }, presence: "offline", registeredAt: 0, lastSeenAt: 0 });
  store.enqueue({ message: { version: 2, id: "m", namespace: "n", from: "alice", to: "bob", conversationId: "c", body: "secret body", createdAt: 1 }, requestKey: "key", fingerprint: "a".repeat(64), maxPending: 1000, maxBodyBytes: 16000 });
  return { path, store, now, advance: (value: number) => { time = value; }, options: { store, now, workerId: "w", leaseMs: 2000, timeoutMs: 20 } };
}

test("count-only adapter call runs outside transaction and success leaves body unread", async () => {
  const f = fixture(); let notification: Notification | undefined;
  const adapter: MessageAdapter = { host: "fake", async notify(n) {
    notification = n;
    const other = createMessageStore({ path: f.path, now: f.now });
    other.setPresence("n", "bob", "busy", 100); other.close();
    return { status: "sent" };
  } };
  expect(await dispatchOnce({ ...f.options, adapters: [adapter] })).toEqual({ claimed: 1, sent: 1, deferred: 0, failed: 0, empty: 0 });
  expect(Object.keys(notification!).sort()).toEqual(["endpoint", "namespace", "notificationId", "peerId", "unread"]);
  expect(notification!.unread).toBe(1);
  expect(JSON.stringify(notification)).not.toContain("secret body");
  expect(f.store.read("n", "bob")).toHaveLength(1);
  expect((await dispatchOnce({ ...f.options, adapters: [adapter] })).claimed).toBe(0);
  f.store.close();
});

test("failed host retries with stable notification ID and does not affect stored receipt", async () => {
  const f = fixture(); const ids: string[] = []; let attempt = 0;
  const adapter: MessageAdapter = { host: "fake", async notify(n) {
    ids.push(n.notificationId); if (++attempt === 1) throw new Error("accepted then connection lost"); return { status: "sent" };
  } };
  expect(await dispatchOnce({ ...f.options, adapters: [adapter] })).toEqual({ claimed: 1, sent: 0, deferred: 0, failed: 1, empty: 0 });
  expect(f.store.read("n", "bob")).toHaveLength(1);
  f.advance(1100);
  expect((await dispatchOnce({ ...f.options, adapters: [adapter] })).sent).toBe(1);
  expect(ids[1]).toBe(ids[0]); f.store.close();
});

test("deferred and missing routes remain retryable past attempt budget", async () => {
  const f = fixture();
  expect((await dispatchOnce({ ...f.options, adapters: [], maxAttempts: 1 })).deferred).toBe(1);
  f.advance(1100);
  const adapter: MessageAdapter = { host: "fake", async notify() { return { status: "deferred", detail: "pending user question", retryAfterMs: 10 }; } };
  expect((await dispatchOnce({ ...f.options, adapters: [adapter], maxAttempts: 1 })).deferred).toBe(1);
  f.advance(2100);
  expect((await dispatchOnce({ ...f.options, adapters: [{ host: "fake", async notify() { return { status: "sent" }; } }], maxAttempts: 1 })).sent).toBe(1);
  f.store.close();
});

test("unsupported and exhausted jobs retain diagnosis without losing mailbox contents", async () => {
  for (const unsupported of [true, false]) {
    const f = fixture();
    const adapter: MessageAdapter = { host: "fake", async notify() {
      if (!unsupported) throw new Error("network unavailable");
      return { status: "unsupported", detail: "host has no safe route" };
    } };
    expect((await dispatchOnce({ ...f.options, adapters: [adapter], maxAttempts: 1 })).failed).toBe(1);
    f.advance(10_000);
    expect((await dispatchOnce({ ...f.options, adapters: [adapter] })).claimed).toBe(0);
    const db = new Database(f.path); const row = db.query("SELECT status,last_error FROM notification_jobs").get() as { status: string; last_error: string };
    expect(row.status).toBe(unsupported ? "unsupported" : "failed"); expect(row.last_error).toBe(unsupported ? "Notification unsupported." : "Notification delivery failed.");
    expect(f.store.read("n", "bob")).toHaveLength(1); db.close(); f.store.close();
  }
});

test("connection accepted then worker dies: lease recovery reuses notification ID", async () => {
  const f = fixture(); const first = f.store.claimNotifications({ now: 100, workerId: "crashed", leaseMs: 10, limit: 1 });
  // Simulated host acceptance without local completion; at-least-once replays are expected.
  f.advance(111); let received = "";
  expect((await dispatchOnce({ ...f.options, adapters: [{ host: "fake", async notify(n) { received = n.notificationId; return { status: "sent" }; } }] })).sent).toBe(1);
  expect(received).toBe(first[0].id); expect(f.store.completeNotification(received, "crashed")).toBe(false);
  f.store.close();
});

test("lease lost during host call cannot be completed by old dispatcher", async () => {
  const f = fixture();
  const adapter: MessageAdapter = { host: "fake", async notify() {
    f.advance(2101);
    expect(f.store.claimNotifications({ now: 2101, workerId: "replacement", leaseMs: 50, limit: 1 })).toHaveLength(1);
    return { status: "sent" };
  } };
  expect(await dispatchOnce({ ...f.options, adapters: [adapter] })).toEqual({ claimed: 1, sent: 0, deferred: 0, failed: 1, empty: 0 });
  expect(f.store.read("n", "bob")).toHaveLength(1);
  f.store.close();
});

test("R2 each job gets its own lease immediately before its host call", async () => {
  const f = fixture();
  f.store.register({ ...f.store.getPeer("n", "bob")!, id: "carol", name: "carol", endpoint: { host: "fake", sessionId: "carol", generation: 1, target: {} } });
  f.store.enqueue({ message: { ...f.store.getMessage("n", "m")!, id: "second", to: "carol" }, fingerprint: "b".repeat(64), maxPending: 1000, maxBodyBytes: 16000 });
  let time = 100; let laterJobAttempts: number | undefined;
  const adapter: MessageAdapter = { host: "fake", async notify(n) {
    if (n.peerId === "bob") laterJobAttempts = f.store.notificationStatus("n", "carol")[0].attempts;
    time += 1500; f.advance(time); return { status: "sent" };
  } };
  const result = await dispatchOnce({ ...f.options, adapters: [adapter] });
  expect(laterJobAttempts).toBe(0);
  expect(result.sent).toBe(2);
  expect(result).toEqual({ claimed: 2, sent: 2, failed: 0, deferred: 0, empty: 0 });
  f.store.close();
});

test("R2 dispatcher timeout aborts even an adapter that never settles", async () => {
  const f = fixture(); let signal: AbortSignal | undefined;
  const started = performance.now();
  const result = await dispatchOnce({ ...f.options, maxAttempts: 1, adapters: [{ host: "fake", async notify(_n, s) { signal = s; return new Promise(() => {}); } }] });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(signal?.aborted).toBe(true); expect(result.failed).toBe(1);
  expect(f.store.notificationStatus("n", "bob")[0]).toMatchObject({ state: "failed", failures: 1, detail: "Notification timed out." });
  f.store.close();
});

test("R2 hostile throws/results never stringify or leak, malformed responses consume failure budget", async () => {
  const poison = { get message() { throw "SECRET"; }, toString() { throw "SECRET"; }, [Symbol.toPrimitive]() { throw "SECRET"; } };
  const cases = [
    async () => { throw poison; },
    async () => null,
    async () => ({ get status() { throw poison; } }),
    async () => ({ status: "deferred", retryAfterMs: NaN }),
    async () => ({ status: "unknown", detail: "SECRET" }),
  ];
  for (const response of cases) {
    const f = fixture();
    const result = await dispatchOnce({ ...f.options, maxAttempts: 1, adapters: [{ host: "fake", notify: response as MessageAdapter["notify"] }] });
    expect(result).toMatchObject({ failed: 1, deferred: 0 });
    const [status] = f.store.notificationStatus("n", "bob");
    expect(status.state).toBe("failed"); expect(status.failures).toBe(1);
    expect(JSON.stringify(status)).not.toContain("SECRET"); f.store.close();
  }
});

test("R2 deferral uses no failure budget and clamps host delays; acked job is empty", async () => {
  const f = fixture();
  for (let i=0; i<3; i++) {
    f.advance(100+i*1000);
    const result = await dispatchOnce({ ...f.options, maxAttempts: 1, adapters: [{ host: "fake", async notify() { return { status: "deferred", retryAfterMs: -1, detail: "SECRET" }; } }] });
    expect(result).toMatchObject({ deferred: 1, failed: 0 });
    expect(f.store.notificationStatus("n", "bob")[0]).toMatchObject({ failures: 0, availableAt: 1100+i*1000, detail: "Notification deferred." });
  }
  f.advance(3100);
  expect((await dispatchOnce({ ...f.options, maxAttempts: 1, adapters: [{ host: "fake", async notify() { throw "host error"; } }] })).failed).toBe(1);
  expect(f.store.notificationStatus("n", "bob")[0]).toMatchObject({ attempts: 4, failures: 1, state: "failed" });
  f.store.close();
  const empty = fixture(); empty.store.ack("n", "bob", ["m"], 100); let called=false;
  expect(await dispatchOnce({ ...empty.options, adapters: [{ host: "fake", async notify() { called=true; return { status: "sent" }; } }] })).toEqual({ claimed: 1, empty: 1, sent: 0, deferred: 0, failed: 0 });
  expect(called).toBe(false); expect(empty.store.notificationStatus("n", "bob")[0].state).toBe("empty"); empty.store.close();
});

test("R2 enqueue during host acceptance survives connection loss in a distinct queued batch", async () => {
  const f = fixture(); let first=true; const ids: string[]=[];
  const adapter: MessageAdapter = { host: "fake", async notify(n) {
    ids.push(n.notificationId);
    if (first) {
      first=false;
      f.store.enqueue({ message: { ...f.store.getMessage("n", "m")!, id: "arrived-during-host" }, fingerprint: "b".repeat(64), maxPending: 1000, maxBodyBytes: 16000 });
      throw "accepted, connection lost";
    }
    return { status: "sent" };
  } };
  expect((await dispatchOnce({ ...f.options, adapters: [adapter] })).failed).toBe(1);
  expect(f.store.notificationStatus("n", "bob").filter(s=>s.state === "pending")).toHaveLength(2);
  f.advance(1100);
  expect((await dispatchOnce({ ...f.options, adapters: [adapter] })).sent).toBe(2);
  expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[0]);
  expect(f.store.read("n", "bob")).toHaveLength(2); f.store.close();
});

test("R2 invalid options and duplicate hosts fail before claiming", async () => {
  const f=fixture();
  for (const options of [{ leaseMs: 1020 }, { timeoutMs: Infinity }, { maxAttempts: 0 }, { limit: -1 }, { workerId: "" }]) {
    await expect(dispatchOnce({ ...f.options, ...options, adapters: [] })).rejects.toThrow();
  }
  const adapter: MessageAdapter={ host:"fake", async notify() { return { status:"sent" }; } };
  await expect(dispatchOnce({ ...f.options, adapters: [adapter,adapter] })).rejects.toThrow();
  expect(f.store.notificationStatus("n", "bob")[0].attempts).toBe(0); f.store.close();
});

test("R2 oversized retry delays are clamped and hostile result detail is never read", async () => {
  const f=fixture(); let detailRead=false;
  const result=await dispatchOnce({ ...f.options, adapters: [{ host:"fake", async notify() {
    return { status:"deferred", retryAfterMs:Number.MAX_VALUE, get detail(): string { detailRead=true; throw "SECRET"; } };
  } }] });
  expect(result.deferred).toBe(1); expect(detailRead).toBe(false);
  expect(f.store.notificationStatus("n", "bob")[0].availableAt).toBe(100+86_400_000);
  f.store.close();
});
