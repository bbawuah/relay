import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageStore } from "../src/storage/store";
import { publishNoReplace } from "../src/storage/publish";
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
      db.query('INSERT INTO receipts VALUES (?,?,?,?,?,?,?)').run('n','alice','crash-key','fingerprint','crash',10,9999999999999);
      db.query('INSERT INTO notification_jobs(id,namespace,peer_id,endpoint,generation,message_id,available_at) VALUES (?,?,?,?,?,?,?)').run('crash-job','n','bob','{}',1,'crash',10);`}
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
  // SQLite may retain an empty private WAL after a clean read-only open. Use
  // a closed, checkpointed copy so this fault setup never overwrites a sidecar.
  const isolated = join(clean.dir, "isolated.sqlite"); copyFileSync(clean.path, isolated);
  const sentinel = join(clean.dir, "sentinel"); writeFileSync(sentinel, "untouched", { mode: 0o600 });
  symlinkSync(sentinel, isolated + "-wal");
  expect(() => createMessageStore({ path: isolated })).toThrow();
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

test("R2 burst coalesces, claimed batch freezes and later arrivals survive lost completion", () => {
  const f = setup();
  for (let i=0; i<20; i++) f.store.enqueue(input(`burst-${i}`));
  const [first] = f.store.claimNotifications({ now: 100, workerId: "old", leaseMs: 10, limit: 100 });
  expect(f.store.notificationStatus("n", "bob")).toHaveLength(1);
  f.store.enqueue(input("during-host"));
  expect(f.store.claimNotifications({ now: 100, workerId: "other", leaseMs: 10, limit: 100 })).toHaveLength(0);
  f.now(111);
  const [recovered] = f.store.claimNotifications({ now: 111, workerId: "new", leaseMs: 10, limit: 100 });
  expect(recovered.id).toBe(first.id);
  expect(f.store.completeNotification(first.id, "old")).toBe(false);
  expect(f.store.completeNotification(first.id, "new")).toBe(true);
  const next = f.store.claimNotifications({ now: 111, workerId: "new", leaseMs: 10, limit: 100 });
  expect(next).toHaveLength(1); expect(next[0].id).not.toBe(first.id);
  f.store.close();
});

test("R2 persisted receipt and minimal reply horizons survive restart and expire independently", () => {
  const f = setup(); f.store.close(); let clock = 100;
  let store = createMessageStore({ path: f.path, now: () => clock, idempotencyMs: 20, referenceMs: 40 });
  const first = store.enqueue(input("root", "key")); expect(first.expiresAt).toBe(120);
  store.ack("n", "bob", ["root"], 101); store.prune(102);
  expect(store.getMessageReference("n", "root")).toMatchObject({ id: "root", from: "alice", to: "bob" });
  expect(store.getMessageReference("n", "root")).not.toHaveProperty("body");
  store.close(); clock=119;
  store = createMessageStore({ path: f.path, now: () => clock, idempotencyMs: 1, referenceMs: 1 });
  expect(store.lookupReceipt("n", "alice", "key", "a".repeat(64))?.expiresAt).toBe(120);
  clock=120; expect(store.lookupReceipt("n", "alice", "key", "changed")).toBeNull();
  expect(store.enqueue(input("new", "key")).duplicate).toBe(false);
  clock=140; expect(store.getMessageReference("n", "root")).toBeNull();
  store.prune(200); expect(store.read("n", "bob").map(m=>m.id)).toEqual(["new"]);
  store.close();
});

test("R2 CAS rebind is atomic, preserves identity and supersedes queued/claimed old endpoints", () => {
  const f = setup(); f.store.enqueue(input("before"));
  const [old] = f.store.claimNotifications({ now: 100, workerId: "old", leaseMs: 50, limit: 1 });
  f.store.enqueue(input("during"));
  const original = f.store.getPeer("n", "bob")!;
  const endpoint = { ...original.endpoint, generation: 2, sessionId: "reconnected", target: { thread: "reconnected" } };
  expect(() => f.store.rebindPeer("n", "bob", 0, endpoint, 100)).toThrow("generation");
  expect(() => f.store.rebindPeer("n", "bob", 1, { ...endpoint, sessionId: "alice" }, 100)).toThrow("conflict");
  expect(f.store.notificationStatus("n", "bob").map(j=>j.state)).toEqual(["pending", "pending"]);
  const rebound = f.store.rebindPeer("n", "bob", 1, endpoint, 100);
  expect(rebound).toMatchObject({ id: original.id, name: original.name, registeredAt: original.registeredAt, endpoint });
  expect(() => f.store.rebindPeer("n", "bob", 1, endpoint, 100)).toThrow("generation");
  expect(f.store.completeNotification(old.id, "old")).toBe(false);
  expect(f.store.notificationStatus("n", "bob").map(j=>j.state)).toEqual(["superseded", "superseded", "pending"]);
  const [next] = f.store.claimNotifications({ now: 100, workerId: "new", leaseMs: 50, limit: 10 });
  expect(next.endpoint).toEqual(endpoint); expect(f.store.read("n", "bob")).toHaveLength(2);
  f.store.close();
});

test("R2 rebind failure rolls back binding, supersession and replacement notification", () => {
  const f = setup(); f.store.enqueue(input("mail"));
  const before = f.store.getPeer("n", "bob")!; const jobs = f.store.notificationStatus("n", "bob");
  const db = new Database(f.path);
  db.exec("CREATE TRIGGER fail_rebind BEFORE INSERT ON notification_jobs BEGIN SELECT RAISE(ABORT, 'injected rebind failure'); END");
  expect(() => f.store.rebindPeer("n", "bob", 1, { ...before.endpoint, generation: 2 }, 100)).toThrow();
  expect(f.store.getPeer("n", "bob")).toEqual(before);
  expect(f.store.notificationStatus("n", "bob")).toEqual(jobs);
  db.exec("DROP TRIGGER fail_rebind"); db.close(); f.store.close();
});

test("R2 T3 registration and reconnect require matching explicit thread target", () => {
  const f = fixture(); const p = peer("t3");
  expect(() => f.store.register({ ...p, endpoint: { host: "t3", generation: 1, sessionId: "s", target: { threadId: "other" } } })).toThrow();
  const valid = { ...p, endpoint: { host: "t3", generation: 1, sessionId: "s", target: { threadId: "s" } } };
  f.store.register(valid);
  expect(() => f.store.rebindPeer("n", "t3", 1, { ...valid.endpoint, generation: 2, sessionId: "new" }, 100)).toThrow();
  expect(f.store.getPeer("n", "t3")?.endpoint).toEqual(valid.endpoint); f.store.close();
});

test("R2 metadata GC preserves pending jobs/unread bodies and status is read-only and scoped", () => {
  const f = setup(); f.store.enqueue(input("acked"));
  const [job] = f.store.claimNotifications({ now: 100, workerId: "w", leaseMs: 100, limit: 1 });
  expect(f.store.failNotification(job.id, "foreign", "secret")).toBe(false);
  expect(f.store.failNotification(job.id, "w", "secret credentials and endpoint")).toBe(true);
  f.store.enqueue(input("unread"));
  const before = f.store.notificationStatus("n", "bob");
  expect(JSON.stringify(before)).not.toContain("secret");
  expect(f.store.notificationStatus("other")).toEqual([]);
  expect(f.store.notificationStatus("n", "alice")).toEqual([]);
  expect(f.store.notificationStatus("n", "bob")).toEqual(before);
  f.store.ack("n", "bob", ["acked"], 101); f.now(10_000_000_000);
  expect(f.store.prune(102)).toBe(1);
  expect(f.store.read("n", "bob").map(m=>m.id)).toEqual(["unread"]);
  expect(f.store.getMessageReference("n", "acked")).toBeNull();
  expect(f.store.getMessageReference("n", "unread")?.id).toBe("unread");
  expect(f.store.notificationStatus("n", "bob").map(j=>j.state)).toEqual(["pending"]);
  f.store.close();
});

test("R2 expired-key replacement rolls back on persistence failure and retries atomically", () => {
  const f=setup(); f.store.close(); let clock=100;
  const store=createMessageStore({ path:f.path, now:()=>clock, idempotencyMs:20 });
  const original=store.enqueue(input("old", "reuse"));
  expect(store.enqueue({ ...input("ignored", "reuse"), maxBodyBytes:0, maxPending:0 })).toEqual({ ...original, duplicate:true });
  clock=120; const db=new Database(f.path);
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END");
  expect(()=>store.enqueue({ ...input("new", "reuse"), fingerprint:"b".repeat(64) })).toThrow();
  expect(store.getMessage("n", "new")).toBeNull();
  expect(db.query("SELECT message_id,expires_at FROM receipts WHERE request_key='reuse'").get()).toEqual({ message_id:"old", expires_at:120 });
  db.exec("DROP TRIGGER fail_receipt");
  const replacement=store.enqueue({ ...input("new", "reuse"), fingerprint:"b".repeat(64) });
  expect(replacement).toMatchObject({ id:"new", duplicate:false, expiresAt:140 });
  expect(store.lookupReceipt("n", "alice", "reuse", "b".repeat(64))?.id).toBe("new");
  db.close(); store.close();
});

test("R2 parallel expired-key retries replace the key only once", async () => {
  const f=setup(); f.store.close();
  const initial=createMessageStore({ path:f.path, now:()=>100, idempotencyMs:20 });
  initial.enqueue(input("old", "reuse")); initial.close();
  const writers=Array.from({ length:4 },(_,i)=>child(`
    import { createMessageStore } from ${JSON.stringify(storeModule)};
    const store=createMessageStore({path:${JSON.stringify(f.path)},now:()=>120,idempotencyMs:20});
    console.log(JSON.stringify(store.enqueue(${JSON.stringify({ ...input(`replacement-${i}`, "reuse"), fingerprint:"b".repeat(64) })})));
    store.close();`, f.dir));
  const receipts=await Promise.all(writers.map(async proc=> {
    expect(await proc.exited).toBe(0); expect(await new Response(proc.stderr).text()).toBe("");
    return JSON.parse(await new Response(proc.stdout).text());
  }));
  expect(receipts.filter(r=>!r.duplicate)).toHaveLength(1);
  expect(new Set(receipts.map(r=>r.id)).size).toBe(1);
  const store=createMessageStore({path:f.path,now:()=>120});
  expect(store.read("n","bob")).toHaveLength(2);
  expect(store.notificationStatus("n","bob")).toHaveLength(1); store.close();
});

test("R2 SIGKILL after host acceptance preserves frozen batch ID and next queued batch", async () => {
  const f=setup(); f.store.enqueue(input("original"));
  const originalId=f.store.notificationStatus("n","bob")[0].id; f.store.close();
  const dispatcherModule=join(import.meta.dir,"../src/dispatch/dispatcher.ts");
  const proc=child(`
    import { createMessageStore } from ${JSON.stringify(storeModule)};
    import { dispatchOnce } from ${JSON.stringify(dispatcherModule)};
    const store=createMessageStore({path:${JSON.stringify(f.path)},now:()=>100});
    await dispatchOnce({store,now:()=>100,adapters:[{host:'fake',async notify(){
      store.enqueue(${JSON.stringify(input("during-host"))});
      console.log('accepted'); return new Promise(()=>{});
    }}]});`, f.dir);
  const reader=proc.stdout.getReader(); const first=await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("accepted");
  proc.kill("SIGKILL"); await proc.exited; reader.releaseLock();
  const recovered=createMessageStore({path:f.path,now:()=>30101});
  expect(recovered.read("n","bob")).toHaveLength(2);
  expect(recovered.notificationStatus("n","bob").filter(j=>j.state==="pending")).toHaveLength(2);
  const jobs=recovered.claimNotifications({now:30101,workerId:"restarted",leaseMs:1000,limit:10});
  expect(jobs).toHaveLength(1); expect(jobs[0].id).toBe(originalId);
  expect(recovered.completeNotification(originalId,"restarted")).toBe(true);
  const next=recovered.claimNotifications({now:30101,workerId:"restarted",leaseMs:1000,limit:10});
  expect(next).toHaveLength(1); expect(next[0].id).not.toBe(originalId); recovered.close();
});

test("B3 simultaneous first store/register processes all succeed with missing parents", async () => {
  for (let round=0;round<3;round++) {
    const dir=join(scratch,`cold-${++seq}`); mkdirSync(dir,{mode:0o700});
    const path=join(dir,"new-parent","nested","messages.sqlite"); const start=join(dir,"start");
    const writers=Array.from({length:4},(_,i)=>child(`
      import { existsSync, writeSync } from 'node:fs';
      import { createMessageStore } from ${JSON.stringify(storeModule)};
      writeSync(1,'ready\\n'); while(!existsSync(${JSON.stringify(start)})) await Bun.sleep(1);
      const store=createMessageStore({path:${JSON.stringify(path)}});
      store.register(${JSON.stringify(peer(`fresh-${i}`))}); store.close();`,dir));
    await Promise.all(writers.map(async proc=>{
      const reader=proc.stdout.getReader(); const first=await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(first.value)).toContain("ready");
    }));
    writeFileSync(start,"go",{mode:0o600});
    const results=await Promise.all(writers.map(async proc=>({code:await proc.exited,error:await new Response(proc.stderr).text()})));
    expect(results).toEqual(Array.from({length:4},()=>({code:0,error:""})));
    const store=createMessageStore({path}); expect(store.listPeers("n")).toHaveLength(4); store.close();
  }
});

test("B3 existing zero-byte and foreign files are refused byte-for-byte unchanged",()=>{
  const dir=join(scratch,`unknown-${++seq}`); mkdirSync(dir,{mode:0o700});
  for(const bytes of [Buffer.alloc(0),Buffer.from("foreign bytes")]){
    const path=join(dir,`unknown-${bytes.length}.sqlite`); writeFileSync(path,bytes,{mode:0o600});
    const before=statSync(path);
    expect(()=>createMessageStore({path})).toThrow();
    expect(readFileSync(path)).toEqual(bytes); expect(statSync(path).ino).toBe(before.ino);
  }
});

test("B3 no-replace syscall preserves existing files and never creates a second link",()=>{
  const dir=join(scratch,`publish-${++seq}`); mkdirSync(dir,{mode:0o700});
  const source=join(dir,"private-初期.sqlite"), target=join(dir,"public-📨.sqlite");
  writeFileSync(source,"complete source",{mode:0o600}); const before=statSync(source);
  writeFileSync(target,"foreign winner",{mode:0o600}); const winner=statSync(target);
  expect(publishNoReplace(source,target)).toBe(false);
  expect(readFileSync(source,"utf8")).toBe("complete source");
  expect(readFileSync(target,"utf8")).toBe("foreign winner"); expect(statSync(target).ino).toBe(winner.ino);
  const fresh=join(dir,"fresh-📨.sqlite"); expect(publishNoReplace(source,fresh)).toBe(true);
  expect(statSync(fresh).ino).toBe(before.ino); expect(statSync(fresh).nlink).toBe(1); expect(existsSync(source)).toBe(false);
  expect(()=>publishNoReplace(fresh,join(dir,"bad\0path"))).toThrow("Invalid atomic publication path");
  expect(readFileSync(fresh,"utf8")).toBe("complete source");
});

for(const after of [false,true]) test(`B3 SIGKILL ${after?"after":"before"} atomic publication leaves recoverable final state`,async()=>{
  const dir=join(scratch,`publish-crash-${++seq}`); mkdirSync(dir,{mode:0o700});
  const path=join(dir,"new-state","messages.sqlite");
  const publisherModule=join(import.meta.dir,"../src/storage/publish.ts");
  const proc=child(`
    import { mock } from 'bun:test'; import { writeSync } from 'node:fs';
    const actual=await import(${JSON.stringify(publisherModule)});
    const publish=actual.publishNoReplace, capability=actual.assertPublishCapability;
    mock.module(${JSON.stringify(publisherModule)},()=>({assertPublishCapability:capability,publishNoReplace:(source,target)=>{
      ${after?"if(!publish(source,target)) throw new Error('unexpected publication loss');":""}
      writeSync(1,JSON.stringify({source,target})+'\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
      throw new Error('parent did not kill process');
    }}));
    const {createMessageStore}=await import(${JSON.stringify(storeModule)});
    createMessageStore({path:${JSON.stringify(path)}});`,dir);
  const reader=proc.stdout.getReader(); const first=await reader.read(); reader.releaseLock();
  const boundary=JSON.parse(new TextDecoder().decode(first.value));
  expect(boundary.target).toBe(path);
  expect(existsSync(path)).toBe(after);
  if(!after){
    const built=new Database(boundary.source,{readonly:true,create:false});
    expect(built.query("PRAGMA user_version").get()).toEqual({user_version:2});
    expect(built.query("SELECT name FROM sqlite_master WHERE name='peers'").get()).toEqual({name:"peers"}); built.close();
  }else expect(statSync(path).nlink).toBe(1);
  proc.kill("SIGKILL"); await proc.exited;
  expect(existsSync(path)).toBe(after);
  const recovered=createMessageStore({path}); recovered.register(peer("after-kill"));
  expect(recovered.listPeers("n").map(p=>p.id)).toEqual(["after-kill"]); recovered.close();
});

test("B3 capability failure leaves absent final path and parents untouched",async()=>{
  const dir=join(scratch,`no-capability-${++seq}`); mkdirSync(dir,{mode:0o700});
  const path=join(dir,"never-created","messages.sqlite");
  const publisherModule=join(import.meta.dir,"../src/storage/publish.ts");
  const proc=child(`
    import {mock} from 'bun:test';
    mock.module(${JSON.stringify(publisherModule)},()=>({assertPublishCapability(){throw new Error('capability unavailable');},publishNoReplace(){throw new Error('must not publish');}}));
    const {createMessageStore}=await import(${JSON.stringify(storeModule)});
    try{createMessageStore({path:${JSON.stringify(path)}});process.exit(2);}catch{console.log('refused');}`,dir);
  expect(await proc.exited).toBe(0); expect(await new Response(proc.stdout).text()).toContain("refused");
  expect(existsSync(path)).toBe(false); expect(existsSync(join(dir,"never-created"))).toBe(false);
});

test("B3 EEXIST publication loser reopens the initialized winner without replacing its inode/data",async()=>{
  const dir=join(scratch,`winner-${++seq}`); mkdirSync(dir,{mode:0o700});
  const path=join(dir,"messages.sqlite"), winnerPath=join(dir,"winner.sqlite");
  const publisherModule=join(import.meta.dir,"../src/storage/publish.ts");
  const proc=child(`
    import {mock} from 'bun:test'; import {statSync} from 'node:fs';
    const actual=await import(${JSON.stringify(publisherModule)}); const publish=actual.publishNoReplace, capability=actual.assertPublishCapability;
    let factory, winnerInode, lost=false;
    mock.module(${JSON.stringify(publisherModule)},()=>({assertPublishCapability:capability,publishNoReplace:(source,target)=>{
      if(target!==${JSON.stringify(path)}) return publish(source,target);
      const winner=factory({path:${JSON.stringify(winnerPath)}}); winner.register(${JSON.stringify(peer("winner"))}); winner.close();
      winnerInode=statSync(${JSON.stringify(winnerPath)}).ino;
      if(!publish(${JSON.stringify(winnerPath)},target)) throw new Error('winner did not publish');
      lost=!publish(source,target); return !lost;
    }}));
    factory=(await import(${JSON.stringify(storeModule)})).createMessageStore;
    const loser=factory({path:${JSON.stringify(path)}}); loser.register(${JSON.stringify(peer("loser"))});
    console.log(JSON.stringify({lost,winnerInode,finalInode:statSync(${JSON.stringify(path)}).ino,ids:loser.listPeers('n').map(p=>p.id).sort()})); loser.close();`,dir);
  expect(await proc.exited).toBe(0); expect(await new Response(proc.stderr).text()).toBe("");
  const result=JSON.parse(await new Response(proc.stdout).text());
  expect(result.lost).toBe(true); expect(result.finalInode).toBe(result.winnerInode); expect(result.ids).toEqual(["loser","winner"]);
  expect(statSync(path).nlink).toBe(1);
});

for(const bytes of ["","foreign winner"]) test(`B3 unknown ${bytes?"foreign":"zero-byte"} EEXIST winner is refused unchanged`,async()=>{
  const dir=join(scratch,`foreign-winner-${++seq}`); mkdirSync(dir,{mode:0o700});
  const path=join(dir,"messages.sqlite"), publisherModule=join(import.meta.dir,"../src/storage/publish.ts");
  const proc=child(`
    import {mock} from 'bun:test'; import {writeFileSync,statSync} from 'node:fs';
    const actual=await import(${JSON.stringify(publisherModule)}); const publish=actual.publishNoReplace, capability=actual.assertPublishCapability;
    let winnerInode;
    mock.module(${JSON.stringify(publisherModule)},()=>({assertPublishCapability:capability,publishNoReplace:(source,target)=>{
      writeFileSync(target,${JSON.stringify(bytes)},{flag:'wx',mode:0o600}); winnerInode=statSync(target).ino;
      return publish(source,target);
    }}));
    const {createMessageStore}=await import(${JSON.stringify(storeModule)});
    try{createMessageStore({path:${JSON.stringify(path)}});process.exit(2);}catch{console.log(JSON.stringify({winnerInode}));}`,dir);
  expect(await proc.exited).toBe(0); expect(await new Response(proc.stderr).text()).toBe("");
  const result=JSON.parse(await new Response(proc.stdout).text());
  expect(statSync(path).ino).toBe(result.winnerInode); expect(readFileSync(path,"utf8")).toBe(bytes);
});

for(const kind of ["symlink","public"]) test(`B3 mkdir EEXIST ${kind} winner is revalidated and refused`,async()=>{
  const dir=join(scratch,`mkdir-race-${++seq}`); mkdirSync(dir,{mode:0o700});
  const foreign=join(dir,"foreign"); mkdirSync(foreign,{mode:0o700}); writeFileSync(join(foreign,"sentinel"),"untouched");
  const parent=join(dir,"raced"), path=join(parent,"messages.sqlite");
  const proc=child(`
    import {mock} from 'bun:test'; import * as fs from 'node:fs';
    const original={...fs};
    mock.module('node:fs',()=>({...original,mkdirSync:(path,options)=>{
      if(path!==${JSON.stringify(parent)}) return original.mkdirSync(path,options);
      ${kind==="symlink"?`original.symlinkSync(${JSON.stringify(foreign)},path);`:`original.mkdirSync(path,{mode:0o755});original.chmodSync(path,0o755);`}
      throw Object.assign(new Error('racing creator won'),{code:'EEXIST'});
    }}));
    const {createMessageStore}=await import(${JSON.stringify(storeModule)});
    try{createMessageStore({path:${JSON.stringify(path)}});process.exit(2);}catch{console.log('refused');}`,dir);
  expect(await proc.exited).toBe(0); expect(await new Response(proc.stdout).text()).toContain("refused");
  expect(existsSync(path)).toBe(false); expect(readFileSync(join(foreign,"sentinel"),"utf8")).toBe("untouched");
});

test("B3 loader redirection is refused before any database path is created",async()=>{
  const dir=join(scratch,`loader-${++seq}`); mkdirSync(dir,{mode:0o700});
  const path=join(dir,"absent","messages.sqlite");
  const proc=child(`
    import {createMessageStore} from ${JSON.stringify(storeModule)};
    process.env.DYLD_LIBRARY_PATH='/unused-project-library';
    try{createMessageStore({path:${JSON.stringify(path)}});process.exit(2);}catch{console.log('refused');}`,dir);
  expect(await proc.exited).toBe(0); expect(await new Response(proc.stdout).text()).toContain("refused");
  expect(existsSync(join(dir,"absent"))).toBe(false);
});
