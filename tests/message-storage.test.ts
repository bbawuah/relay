import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageStore } from "../src/storage/store";
import type { EnqueueInput, Peer } from "../src/messages/contracts";

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "relay-message-storage-"));
console.log(`Message storage fixtures retained: ${scratch}`);
let seq = 0;
function fixture() {
  const dir = join(scratch, String(++seq)); mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, "messages.sqlite");
  let clock = 100;
  const store = createMessageStore({ path, now: () => clock });
  return { path, dir, store, now: (value: number) => { clock = value; } };
}
function peer(id: string, namespace = "n"): Peer {
  return { id, namespace, name: id, endpoint: { host: "fake", sessionId: id, generation: 1, target: { thread: id } }, presence: "offline", registeredAt: 1, lastSeenAt: 1 };
}
function input(id: string, requestKey = id, namespace = "n"): EnqueueInput {
  return { message: { version: 2, id, namespace, from: "alice", to: "bob", conversationId: id, body: "hello", createdAt: 10 }, requestKey, fingerprint: "a".repeat(64), maxPending: 1000, maxBodyBytes: 16000 };
}
function setup() { const f = fixture(); f.store.register(peer("alice")); f.store.register(peer("bob")); return f; }
const storeModule = join(import.meta.dir, "../src/storage/store.ts");
function child(script: string, dir: string) {
  const home = join(dir, `home-${++seq}`); mkdirSync(home, { mode: 0o700 });
  return Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], {
    cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_STATE_DIR: join(home, "state") },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
}

test("parallel processes retry one request atomically with one outbox job", async () => {
  const f = setup(); f.store.close();
  const writers = Array.from({ length: 6 }, (_, i) => child(`
    import { createMessageStore } from ${JSON.stringify(storeModule)};
    const store=createMessageStore({path:${JSON.stringify(f.path)}});
    console.log(JSON.stringify(store.enqueue(${JSON.stringify(input(`writer-${i}`, "parallel"))})));
    store.close();`, f.dir));
  const results = await Promise.all(writers.map(async process => ({ code: await process.exited, out: await new Response(process.stdout).text(), err: await new Response(process.stderr).text() })));
  for (const result of results) { expect(result.err).toBe(""); expect(result.code).toBe(0); }
  const receipts = results.map(result => JSON.parse(result.out));
  expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(1);
  expect(receipts.filter(receipt => !receipt.duplicate)).toHaveLength(1);
  const store = createMessageStore({ path: f.path });
  expect(store.read("n", "bob")).toHaveLength(1);
  expect(store.claimNotifications({ now: Date.now(), workerId: "w", leaseMs: 100, limit: 20 })).toHaveLength(1);
  store.close();
});

for (const committed of [false, true]) test(`SIGKILL ${committed ? "after" : "before"} commit recovers a coherent message/receipt/outbox`, async () => {
  const f = setup(); f.store.close();
  const process = child(`
    import { createMessageStore } from ${JSON.stringify(storeModule)};
    import { Database } from 'bun:sqlite';
    const store=createMessageStore({path:${JSON.stringify(f.path)}});
    ${committed ? `store.enqueue(${JSON.stringify(input("crash", "crash-key"))});` : `
      const db=new Database(${JSON.stringify(f.path)});
      db.exec('BEGIN IMMEDIATE');
      db.query('INSERT INTO messages(namespace,id,sender,recipient,created_at,envelope) VALUES (?,?,?,?,?,?)').run('n','crash','alice','bob',10,${JSON.stringify(JSON.stringify(input("crash").message))});
      db.query('INSERT INTO receipts VALUES (?,?,?,?,?,?)').run('n','alice','crash-key','fingerprint','crash',10);
      db.query('INSERT INTO notification_jobs(id,namespace,peer_id,endpoint,message_id,available_at) VALUES (?,?,?,?,?,?)').run('crash-job','n','bob','{}','crash',10);`}
    console.log('ready'); setInterval(()=>{},1000);`, f.dir);
  const reader = process.stdout.getReader();
  const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain("ready");
  process.kill("SIGKILL"); await process.exited; reader.releaseLock();
  expect(existsSync(f.path + "-wal")).toBe(true);
  const recovered = createMessageStore({ path: f.path });
  expect(recovered.read("n", "bob")).toHaveLength(committed ? 1 : 0);
  const receipt = recovered.enqueue(input("retry-after-crash", "crash-key"));
  expect(receipt.duplicate).toBe(committed);
  expect(recovered.read("n", "bob")).toHaveLength(1);
  expect(recovered.claimNotifications({ now: Date.now(), workerId: "recovered", leaseMs: 100, limit: 10 })).toHaveLength(1);
  recovered.close();
});

test("busy writer fails within bounded wait and does not poison identical retry", () => {
  const f = setup(); const blocker = new Database(f.path); blocker.exec("BEGIN IMMEDIATE");
  const before = performance.now();
  expect(() => f.store.enqueue(input("busy", "busy-key"))).toThrow();
  const elapsed = performance.now() - before; expect(elapsed).toBeGreaterThan(500); expect(elapsed).toBeLessThan(3000);
  blocker.exec("ROLLBACK");
  expect(f.store.enqueue(input("busy", "busy-key")).duplicate).toBe(false);
  expect(f.store.read("n", "bob")).toHaveLength(1); blocker.close(); f.store.close();
});

test("enqueue is durable, retry returns original receipt, changed payload conflicts", () => {
  const f = setup(); const first = f.store.enqueue(input("m1", "key"));
  expect(f.store.enqueue(input("generated-again", "key"))).toEqual({ ...first, duplicate: true });
  expect(() => f.store.enqueue({ ...input("m2", "key"), fingerprint: "b".repeat(64) })).toThrow("conflict");
  expect(f.store.read("n", "bob").map(m => m.id)).toEqual(["m1"]);
  f.store.close();
  const reopened = createMessageStore({ path: f.path });
  expect(reopened.read("n", "bob")).toHaveLength(1);
  expect(reopened.claimNotifications({ now: 100, workerId: "w", leaseMs: 50, limit: 10 })).toHaveLength(1);
  reopened.close();
});

test("R1 keyed reply receipt survives pruning original and reply; changed payload conflicts", () => {
  const f = setup(); f.store.enqueue(input("original"));
  const reply = { ...input("reply", "reply-key"), fingerprint: "b".repeat(64), message: {
    ...input("reply").message, from: "bob", to: "alice", conversationId: "original", replyTo: "original"
  } };
  const receipt = f.store.enqueue(reply);
  expect(f.store.ack("n", "bob", ["original"], 20)).toBe(1);
  expect(f.store.ack("n", "alice", ["reply"], 20)).toBe(1);
  expect(f.store.prune(21)).toBe(2);
  expect(f.store.getMessage("n", "original")).toBeNull();
  expect(f.store.getMessage("n", "reply")).toBeNull();
  expect(f.store.lookupReceipt("n", "bob", "reply-key", reply.fingerprint)).toEqual({ ...receipt, duplicate: true });
  expect(() => f.store.lookupReceipt("n", "bob", "reply-key", "c".repeat(64))).toThrow("conflict");
  expect(f.store.lookupReceipt("other", "bob", "reply-key", reply.fingerprint)).toBeNull();
  expect(f.store.lookupReceipt("n", "alice", "reply-key", reply.fingerprint)).toBeNull();
  expect(f.store.enqueue({ ...reply, message: { ...reply.message, id: "regenerated" } })).toEqual({ ...receipt, duplicate: true });
  expect(() => f.store.enqueue({ ...reply, fingerprint: "c".repeat(64) })).toThrow("conflict");
  f.store.close();
});

test("failed insert rolls back receipt and outbox, identical retry actually stores", () => {
  const f = setup(); const db = new Database(f.path);
  db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON notification_jobs BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END");
  expect(() => f.store.enqueue(input("m1", "retry"))).toThrow();
  expect(f.store.read("n", "bob")).toEqual([]);
  expect(db.query("SELECT count(*) AS n FROM receipts").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_outbox");
  expect(f.store.enqueue(input("m1", "retry")).duplicate).toBe(false);
  expect(f.store.read("n", "bob")).toHaveLength(1);
  db.close(); f.store.close();
});

test("repeated text with different keys is delivered, reads and ack stay mailbox scoped", () => {
  const f = setup(); f.store.register(peer("bob", "other"));
  f.store.enqueue(input("m1")); f.store.enqueue(input("m2"));
  expect(f.store.read("n", "bob").map(m => m.id)).toEqual(["m1", "m2"]);
  expect(f.store.read("n", "bob")).toHaveLength(2);
  expect(f.store.ack("n", "alice", ["m1"], 20)).toBe(0);
  expect(f.store.ack("other", "bob", ["m1"], 20)).toBe(0);
  expect(f.store.ack("n", "bob", ["m1", "m1"], 20)).toBe(1);
  expect(f.store.ack("n", "bob", ["m1"], 21)).toBe(0);
  expect(f.store.read("n", "bob").map(m => m.id)).toEqual(["m2"]);
  expect(f.store.getMessage("n", "m1")?.id).toBe("m1");
  expect(f.store.prune(21)).toBe(1);
  expect(f.store.enqueue(input("new-generated", "m1")).duplicate).toBe(true);
  f.store.close();
});

test("limits and unknown recipients reserve no request key", () => {
  const f = setup();
  expect(() => f.store.enqueue({ ...input("large", "key"), maxBodyBytes: 1 })).toThrow();
  expect(() => f.store.enqueue({ ...input("full", "key"), maxPending: 0 })).toThrow();
  expect(() => f.store.enqueue({ ...input("unknown", "key"), message: { ...input("unknown").message, to: "missing" } })).toThrow();
  expect(f.store.enqueue(input("valid", "key")).duplicate).toBe(false);
  f.store.close();
});

test("registration is immutable with atomic alias and session uniqueness", () => {
  const f = fixture(); const alice = peer("alice"); f.store.register(alice);
  expect(f.store.register(alice)).toEqual(alice);
  expect(() => f.store.register({ ...peer("other"), name: "ALICE" })).toThrow();
  expect(() => f.store.register({ ...peer("other"), endpoint: alice.endpoint })).toThrow();
  expect(() => f.store.register({ ...alice, endpoint: { ...alice.endpoint, generation: 2 } })).toThrow();
  expect(f.store.findPeer("n", "ALICE")?.id).toBe("alice");
  expect(f.store.listPeers("n")).toHaveLength(1);
  f.store.close();
});

test("expired leases recover after restart and stale workers cannot finish or retry", () => {
  const f = setup(); f.store.enqueue(input("m1"));
  const [job] = f.store.claimNotifications({ now: 100, workerId: "dead", leaseMs: 10, limit: 1 });
  expect(f.store.claimNotifications({ now: 109, workerId: "new", leaseMs: 10, limit: 1 })).toHaveLength(0);
  f.store.close();
  const store = createMessageStore({ path: f.path, now: () => 111 });
  expect(store.claimNotifications({ now: 111, workerId: "new", leaseMs: 10, limit: 1 })[0].attempts).toBe(2);
  expect(store.completeNotification(job.id, "dead")).toBe(false);
  expect(store.retryNotification({ id: job.id, workerId: "dead", availableAt: 120, error: "stale", maxAttempts: 3 })).toBe(false);
  expect(store.completeNotification(job.id, "new")).toBe(true);
  expect(store.read("n", "bob")).toHaveLength(1);
  store.close();
});

test("unknown files, application IDs, links and public paths are refused untouched", () => {
  const f = fixture(); f.store.close();
  const unknown = join(f.dir, "unknown"); writeFileSync(unknown, "sentinel", { mode: 0o600 });
  const before = readFileSync(unknown);
  expect(() => createMessageStore({ path: unknown })).toThrow();
  expect(readFileSync(unknown)).toEqual(before);
  const foreign = join(f.dir, "foreign.sqlite"); const db = new Database(foreign, { create: true });
  db.exec("CREATE TABLE unrelated (id TEXT)"); db.close(); chmodSync(foreign, 0o600);
  const foreignBefore = readFileSync(foreign);
  expect(() => createMessageStore({ path: foreign })).toThrow();
  expect(readFileSync(foreign)).toEqual(foreignBefore);
  const link = join(f.dir, "link.sqlite"); symlinkSync(f.path, link);
  expect(() => createMessageStore({ path: link })).toThrow();
  const hard = join(f.dir, "hard.sqlite"); linkSync(f.path, hard);
  expect(() => createMessageStore({ path: hard })).toThrow();
  const publicDir = join(f.dir, "public"); mkdirSync(publicDir); chmodSync(publicDir, 0o755);
  expect(() => createMessageStore({ path: join(publicDir, "messages.sqlite") })).toThrow();
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
});

test("foreign schema, unsafe sidecars and symlink ancestors are refused without changes", () => {
  const f = fixture(); f.store.close();
  const db = new Database(f.path); db.exec("CREATE TABLE unknown_table (value TEXT)"); db.close();
  const before = readFileSync(f.path);
  expect(() => createMessageStore({ path: f.path })).toThrow("schema");
  expect(readFileSync(f.path)).toEqual(before);
  const clean = fixture(); clean.store.close();
  const sentinel = join(clean.dir, "sentinel"); writeFileSync(sentinel, "untouched", { mode: 0o600 });
  symlinkSync(sentinel, clean.path + "-wal");
  expect(() => createMessageStore({ path: clean.path })).toThrow();
  expect(readFileSync(sentinel, "utf8")).toBe("untouched");
  const ancestor = join(scratch, `ancestor-${++seq}`); symlinkSync(clean.dir, ancestor);
  expect(() => createMessageStore({ path: join(ancestor, "child", "messages.sqlite") })).toThrow();
  expect(existsSync(join(clean.dir, "child"))).toBe(false);
});

test("scope of request keys is namespace and sender; limits count UTF-8 bytes", () => {
  const f = setup();
  f.store.enqueue(input("first", "shared"));
  expect(f.store.enqueue({ ...input("second", "shared"), message: { ...input("second").message, from: "bob", to: "alice" } }).duplicate).toBe(false);
  for (const id of ["alice", "bob"]) f.store.register(peer(id, "other"));
  expect(f.store.enqueue(input("third", "shared", "other")).duplicate).toBe(false);
  expect(() => f.store.enqueue({ ...input("unicode"), message: { ...input("unicode").message, body: "😀" }, maxBodyBytes: 3 })).toThrow();
  expect(f.store.enqueue({ ...input("unicode"), message: { ...input("unicode").message, body: "😀" }, maxBodyBytes: 4 }).duplicate).toBe(false);
  f.store.close();
});

test("expired lease cannot complete even before another worker reclaims it", () => {
  const f = setup(); f.store.enqueue(input("m1"));
  const [job] = f.store.claimNotifications({ now: 100, workerId: "w", leaseMs: 10, limit: 1 });
  f.now(110);
  expect(f.store.completeNotification(job.id, "w")).toBe(false);
  expect(f.store.retryNotification({ id: job.id, workerId: "w", availableAt: 200, error: "late", maxAttempts: 5 })).toBe(false);
  expect(f.store.claimNotifications({ now: 110, workerId: "replacement", leaseMs: 10, limit: 1 })).toHaveLength(1);
  f.store.close();
});
