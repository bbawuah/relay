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
  return { path, store, now, advance: (value: number) => { time = value; }, options: { store, now, workerId: "w", leaseMs: 50 } };
}

test("count-only adapter call runs outside transaction and success leaves body unread", async () => {
  const f = fixture(); let notification: Notification | undefined;
  const adapter: MessageAdapter = { host: "fake", async notify(n) {
    notification = n;
    const other = createMessageStore({ path: f.path, now: f.now });
    other.setPresence("n", "bob", "busy", 100); other.close();
    return { status: "sent" };
  } };
  expect(await dispatchOnce({ ...f.options, adapters: [adapter] })).toEqual({ claimed: 1, sent: 1, deferred: 0, failed: 0 });
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
  expect(await dispatchOnce({ ...f.options, adapters: [adapter] })).toEqual({ claimed: 1, sent: 0, deferred: 1, failed: 0 });
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
  f.advance(1110);
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
    expect(row.status).toBe("failed"); expect(row.last_error).toContain(unsupported ? "safe route" : "network unavailable");
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
    f.advance(151);
    expect(f.store.claimNotifications({ now: 151, workerId: "replacement", leaseMs: 50, limit: 1 })).toHaveLength(1);
    return { status: "sent" };
  } };
  expect(await dispatchOnce({ ...f.options, adapters: [adapter] })).toEqual({ claimed: 1, sent: 0, deferred: 0, failed: 1 });
  expect(f.store.read("n", "bob")).toHaveLength(1);
  f.store.close();
});
