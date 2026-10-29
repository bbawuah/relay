import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacy, type MigrationOptions } from "../src/migration/index";
import { createMessageStore } from "../src/storage/index";

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "relay-message-migration-"));
console.log(`Migration fixtures retained: ${scratch}`);
let sequence = 0;
const legacy = (id: string, extra: Record<string, unknown> = {}) => ({ id, van: "Alice", naar: "Bob", draad: "conversation-original", ts: "2026-10-01T12:00:00.000Z", tekst: "hello $() `literal`", hop: 1, herkomst: "schoon", soort: "bericht", ...extra });
function fixture(messages = [legacy("m1"), legacy("m2", { antwoord_op: "m1" })], held: ReturnType<typeof legacy>[] = []) {
  const dir = join(scratch, String(++sequence)); mkdirSync(dir, { mode: 0o700 });
  const sourceDir = join(dir, "old"); const destinationDir = join(dir, "new");
  for (const part of ["register", "peers/inbox", "peers/vastgehouden"]) mkdirSync(join(sourceDir, part), { recursive: true, mode: 0o700 });
  for (const name of ["Alice", "Bob"]) writeFileSync(join(sourceDir, "register", `${name}.json`), JSON.stringify({ id: `session-${name}`, naam: name, rol: "lead", host: "t3", threadId: "must-never-be-used" }), { mode: 0o600 });
  writeFileSync(join(sourceDir, "peers/inbox/bob.jsonl"), messages.map(message => JSON.stringify(message) + "\n").join(""), { mode: 0o600 });
  writeFileSync(join(sourceDir, "peers/vastgehouden/bob.jsonl"), held.map(message => JSON.stringify(message) + "\n").join(""), { mode: 0o600 });
  const options: MigrationOptions = { sourceDir, destinationDir, namespace: "n", sourceQuiesced: true, now: () => 100 };
  return { dir, sourceDir, destinationDir, options, db: () => createMessageStore({ path: join(destinationDir, "messages.sqlite"), now: () => 100 }) };
}
function bytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(path); else out[path] = readFileSync(join(dir, path)).toString("base64");
    }
  };
  walk(""); return out;
}

test("ordinary/acked import preserves IDs, body, replies, bytes and deterministic manual peers", () => {
  const f = fixture();
  writeFileSync(join(f.sourceDir, "peers/inbox/bob.gelezen"), "m1\n", { mode: 0o600 });
  const before = bytes(f.sourceDir);
  const report = migrateLegacy(f.options);
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  expect(report.messages).toBe(2); expect(report.acknowledgements).toBe(1); expect(report.importedThisRun).toBe(2);
  const store = f.db();
  expect(store.read("n", report.peerMapping.Bob).map(message => message.id)).toEqual(["m2"]);
  expect(store.getMessage("n", "m1")?.body).toBe(legacy("m1").tekst);
  expect(store.getMessage("n", "m2")?.replyTo).toBe("m1");
  expect(store.getMessage("n", "m2")?.conversationId).toBe("conversation-original");
  expect(store.listPeers("n").every(peer => peer.endpoint.host === "manual" && peer.endpoint.sessionId === peer.id && Object.keys(peer.endpoint.target).length === 0)).toBe(true);
  store.close();
  expect(bytes(f.sourceDir)).toEqual(before);
  const again = migrateLegacy(f.options);
  expect(again.resumed).toBe(true); expect(again.importedThisRun).toBe(0); expect(again.peerMapping).toEqual(report.peerMapping);
  expect(bytes(f.sourceDir)).toEqual(before);
});

test("held data stays quarantined by default, then explicit import delivers it once", () => {
  const f = fixture([legacy("m1")], [legacy("held", { tekst: "previously held", herkomst: "extern" })]);
  const initial = migrateLegacy(f.options);
  expect(initial.held).toEqual({ total: 1, quarantined: 1, imported: 0, skipped: 0, action: "quarantine" });
  const store = f.db(); expect(store.getMessage("n", "held")).toBeNull(); store.close();
  const quarantine = readFileSync(join(f.destinationDir, "legacy-quarantine.json"), "utf8");
  expect(JSON.parse(quarantine).messages[0].envelope.tekst).toBe("previously held");
  const imported = migrateLegacy({ ...f.options, held: "import" });
  expect(imported.importedThisRun).toBe(1); expect(imported.held.imported).toBe(1);
  const reopened = f.db(); expect(reopened.read("n", imported.peerMapping.Bob).map(message => message.id)).toEqual(["m1", "held"]); reopened.close();
  expect(migrateLegacy(f.options).importedThisRun).toBe(0);
  expect(readFileSync(join(f.destinationDir, "legacy-quarantine.json"), "utf8")).toBe(quarantine);
});

test("explicit held skip is durable and cannot later silently become delivery", () => {
  const f = fixture([], [legacy("held")]);
  expect(migrateLegacy({ ...f.options, held: "skip" }).held.skipped).toBe(1);
  expect(migrateLegacy(f.options).held.skipped).toBe(1);
  expect(() => migrateLegacy({ ...f.options, held: "import" })).toThrow("cannot be reversed");
  const store = f.db(); expect(store.getMessage("n", "held")).toBeNull(); store.close();
});

test("explicit held import preserves historical acknowledgements across retention", () => {
  const f = fixture([], [legacy("held")]);
  writeFileSync(join(f.sourceDir, "peers/inbox/bob.gelezen"), "held\nalready-pruned\n", { mode: 0o600 });
  const first = migrateLegacy(f.options); expect(first.orphanAcknowledgements).toBe(1);
  const imported = migrateLegacy({ ...f.options, held: "import" }); expect(imported.acknowledgements).toBe(1);
  const later = 32 * 24 * 60 * 60 * 1000;
  const store = createMessageStore({ path: join(f.destinationDir, "messages.sqlite"), now: () => later });
  expect(store.unread("n", imported.peerMapping.Bob)).toBe(0); expect(store.prune(later)).toBe(1); store.close();
  expect(migrateLegacy({ ...f.options, held: "import", now: () => later }).importedThisRun).toBe(0);
});

test("complete import survives receipt/reference expiry, ack/body pruning and process restart", () => {
  const f = fixture(); const first = migrateLegacy(f.options);
  const later = 32 * 24 * 60 * 60 * 1000;
  const store = createMessageStore({ path: join(f.destinationDir, "messages.sqlite"), now: () => later });
  store.ack("n", first.peerMapping.Bob, ["m1", "m2"], later - 1);
  expect(store.prune(later)).toBe(2); expect(store.getMessageReference("n", "m1")).toBeNull(); store.close();
  const again = migrateLegacy({ ...f.options, now: () => later });
  expect(again.completed).toBe(true); expect(again.importedThisRun).toBe(0);
  const reopened = f.db(); expect(reopened.unread("n", first.peerMapping.Bob)).toBe(0); expect(reopened.getMessage("n", "m1")).toBeNull(); reopened.close();
});

for (const crashStage of ["stored", "done"]) test(`SIGKILL before durable ${crashStage} resumes actual committed bodies/acks`, async () => {
  const f = fixture([legacy("m1")]);
  writeFileSync(join(f.sourceDir, "peers/inbox/bob.gelezen"), "m1\n", { mode: 0o600 });
  const home = join(f.dir, "home"); mkdirSync(home, { mode: 0o700 });
  const script = `
    import { Database } from 'bun:sqlite';
    import { migrateLegacy } from ${JSON.stringify(join(import.meta.dir, "../src/migration/index.ts"))};
    const original = Database.prototype.query;
    Database.prototype.query = function(sql) {
      const statement = original.call(this, sql);
      if(sql === 'UPDATE entries SET stage=? WHERE id=?') {
        const run = statement.run.bind(statement);
        statement.run = (...args) => { if(args[0] === ${JSON.stringify(crashStage)}) process.kill(process.pid, 'SIGKILL'); return run(...args); };
      }
      return statement;
    };
    migrateLegacy({...${JSON.stringify({ ...f.options, now: undefined })},now:()=>100});
  `;
  const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], { cwd: f.dir, env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_STATE_DIR: join(home, "state") }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  await child.exited;
  expect(await new Response(child.stderr).text()).toBe(""); expect(child.signalCode).toBe("SIGKILL");
  const pre = f.db(); expect(pre.getMessage("n", "m1")).not.toBeNull();
  if (crashStage === "done") { expect(pre.read("n", pre.listPeers("n").find(peer => peer.name === "Bob")!.id)).toHaveLength(0); }
  pre.close();
  const later = 32 * 24 * 60 * 60 * 1000;
  if (crashStage === "done") {
    const retained = createMessageStore({ path: join(f.destinationDir, "messages.sqlite"), now: () => later });
    expect(retained.prune(later)).toBe(1); expect(retained.getMessageReference("n", "m1")).toBeNull(); retained.close();
  }
  const report = migrateLegacy({ ...f.options, now: () => later }); expect(report.resumed).toBe(true); expect(report.importedThisRun).toBe(0);
  const store = f.db(); expect(store.unread("n", report.peerMapping.Bob)).toBe(0);
  if (crashStage === "done") expect(store.getMessage("n", "m1")).toBeNull();
  store.close();
});

test("namespace mappings and mailboxes are independent; mismatched resume refuses", () => {
  const f = fixture(); const a = migrateLegacy(f.options);
  const b = migrateLegacy({ ...f.options, namespace: "other", destinationDir: join(f.dir, "other") });
  expect(a.peerMapping.Bob).not.toBe(b.peerMapping.Bob);
  expect(() => migrateLegacy({ ...f.options, namespace: "other" })).toThrow("conflict");
});

test("changed snapshot refuses without changing target or source", () => {
  const f = fixture(); migrateLegacy(f.options);
  writeFileSync(join(f.sourceDir, "peers/inbox/bob.jsonl"), JSON.stringify(legacy("m1", { tekst: "changed" })) + "\n");
  const target = bytes(f.destinationDir); const source = bytes(f.sourceDir);
  expect(() => migrateLegacy(f.options)).toThrow("conflict");
  expect(bytes(f.sourceDir)).toEqual(source); expect(bytes(f.destinationDir)).toEqual(target);
});

test("conflicting target ID is rejected before any further message writes", () => {
  const f = fixture(); const report = migrateLegacy(f.options);
  const later = 32 * 24 * 60 * 60 * 1000;
  const store = createMessageStore({ path: join(f.destinationDir, "messages.sqlite"), now: () => later });
  store.ack("n", report.peerMapping.Bob, ["m2"], later - 1); store.prune(later);
  store.enqueue({ message: { version: 2, id: "m2", namespace: "n", from: report.peerMapping.Alice, to: report.peerMapping.Bob, body: "conflicting text", conversationId: "conversation-original", createdAt: Date.parse(legacy("m2").ts) }, fingerprint: "different", maxPending: 1000, maxBodyBytes: 16000 });
  store.close();
  expect(() => migrateLegacy({ ...f.options, now: () => later })).toThrow("conflicting target message ID");
});

test("bounded wide UTF-8 legacy text is preserved above the ordinary byte limit", () => {
  const text = "界".repeat(16_000);
  const f = fixture([legacy("wide", { tekst: text })]); const report = migrateLegacy(f.options);
  expect(report.legacyBodiesAboveSendLimit).toBe(1);
  const store = f.db(); expect(store.getMessage("n", "wide")?.body).toBe(text); store.close();
});

for (const bad of ["not json", JSON.stringify(legacy("bad", { tekst: "a".repeat(16_001) })), JSON.stringify(legacy("bad", { van: "../escape" })), JSON.stringify(legacy("bad", { ts: "nonsense" })), JSON.stringify(legacy("bad", { naar: "Alice" }))]) test(`malformed source refuses all target writes: ${bad.slice(0, 28)}`, () => {
  const f = fixture(); writeFileSync(join(f.sourceDir, "peers/inbox/bob.jsonl"), bad + "\n");
  expect(() => migrateLegacy(f.options)).toThrow(); expect(existsSync(f.destinationDir)).toBe(false);
});

test("quiescence is explicit and overlap is refused before writing", () => {
  const f = fixture(); expect(() => migrateLegacy({ ...f.options, sourceQuiesced: false })).toThrow("stop old writers");
  for (const destinationDir of [f.sourceDir, join(f.sourceDir, "v2"), f.dir]) expect(() => migrateLegacy({ ...f.options, destinationDir })).toThrow("overlap");
  // On case-insensitive filesystems the differently spelled path is the same tree.
  const foldedPath = join(f.dir, "OLD");
  if (existsSync(foldedPath)) expect(() => migrateLegacy({ ...f.options, destinationDir: join(foldedPath, "v2") })).toThrow("overlap");
  expect(existsSync(f.destinationDir)).toBe(false);
});

for (const kind of ["symlink", "hardlink", "directory", "casefold"]) test(`unsafe source ${kind} is refused before writing`, () => {
  const f = fixture(); const file = join(f.sourceDir, "peers/inbox/bob.jsonl");
  if (kind === "hardlink") linkSync(file, join(f.dir, "linked"));
  else if (kind === "casefold") writeFileSync(join(f.sourceDir, "register/twin.json"), JSON.stringify({ id: "twin", naam: "bob" }), { mode: 0o600 });
  else { rmSync(file); if (kind === "symlink") symlinkSync(join(f.sourceDir, "register/Alice.json"), file); else mkdirSync(file); }
  expect(() => migrateLegacy(f.options)).toThrow(); expect(existsSync(f.destinationDir)).toBe(false);
});

test("symlink ancestors, unrelated destinations and corrupt markers remain intact", () => {
  const f = fixture(); const linked = join(f.dir, "linked"); symlinkSync(f.sourceDir, linked);
  expect(() => migrateLegacy({ ...f.options, sourceDir: linked })).toThrow("linked");
  mkdirSync(f.destinationDir, { mode: 0o700 }); const unknown = join(f.destinationDir, "messages.sqlite"); writeFileSync(unknown, "unrelated", { mode: 0o600 });
  expect(() => migrateLegacy(f.options)).toThrow("unrelated"); expect(readFileSync(unknown, "utf8")).toBe("unrelated");
  rmSync(unknown); const marker = join(f.destinationDir, "migration.sqlite"); writeFileSync(marker, "corrupt", { mode: 0o600 });
  expect(() => migrateLegacy(f.options)).toThrow("corrupt"); expect(readFileSync(marker, "utf8")).toBe("corrupt");
});

test("unsafe destination links/private permissions and corrupt quarantine are refused", () => {
  const f = fixture(); migrateLegacy(f.options);
  const quarantine = join(f.destinationDir, "legacy-quarantine.json"); writeFileSync(quarantine, "unknown");
  expect(() => migrateLegacy(f.options)).toThrow("quarantine"); expect(readFileSync(quarantine, "utf8")).toBe("unknown");
  chmodSync(f.destinationDir, 0o755); expect(() => migrateLegacy(f.options)).toThrow("private");
});

for (const kind of ["symlink", "hardlink"]) test(`unsafe destination ${kind} is refused without following it`, () => {
  const f = fixture(); migrateLegacy(f.options);
  const target = join(f.destinationDir, "legacy-quarantine.json"); const external = join(f.dir, "external");
  writeFileSync(external, "leave intact", { mode: 0o600 }); rmSync(target);
  if (kind === "symlink") symlinkSync(external, target); else linkSync(external, target);
  expect(() => migrateLegacy(f.options)).toThrow("unsafe"); expect(readFileSync(external, "utf8")).toBe("leave intact");
});

test("unrecognized target database and ledger schema are left byte-for-byte intact", () => {
  const f = fixture(); migrateLegacy(f.options);
  const target = join(f.destinationDir, "messages.sqlite"); rmSync(target); writeFileSync(target, "unknown database", { mode: 0o600 });
  const before = bytes(f.destinationDir);
  expect(() => migrateLegacy(f.options)).toThrow(); expect(bytes(f.destinationDir)).toEqual(before);
  const other = fixture(); mkdirSync(other.destinationDir, { mode: 0o700 });
  const path = join(other.destinationDir, "migration.sqlite"); writeFileSync(path, "", { mode: 0o600 });
  const db = new Database(path); db.exec("PRAGMA application_id=1380732209; PRAGMA user_version=1; CREATE TABLE unrelated (id TEXT)"); db.close();
  const original = readFileSync(path);
  expect(() => migrateLegacy(other.options)).toThrow(); expect(readFileSync(path)).toEqual(original);
});

test("duplicate IDs, invalid UTF-8 and foreign acknowledgements fail before destination creation", () => {
  const duplicate = fixture([legacy("same"), legacy("same")]);
  expect(() => migrateLegacy(duplicate.options)).toThrow("duplicate"); expect(existsSync(duplicate.destinationDir)).toBe(false);
  const utf8 = fixture(); writeFileSync(join(utf8.sourceDir, "peers/inbox/bob.jsonl"), Buffer.from([0xff]));
  expect(() => migrateLegacy(utf8.options)).toThrow("UTF-8"); expect(existsSync(utf8.destinationDir)).toBe(false);
  const foreign = fixture(); writeFileSync(join(foreign.sourceDir, "peers/inbox/alice.gelezen"), "m1\n", { mode: 0o600 });
  expect(() => migrateLegacy(foreign.options)).toThrow("another mailbox"); expect(existsSync(foreign.destinationDir)).toBe(false);
});

test("a writer changing a file while it is read is detected before target writes", async () => {
  const f = fixture(); const home = join(f.dir, "home"); mkdirSync(home, { mode: 0o700 });
  const file = join(f.sourceDir, "register/Alice.json");
  const record = JSON.stringify({ id: "session-Alice", naam: "Alice", padding: "x".repeat(8 * 1024 * 1024) });
  writeFileSync(file, record);
  const script = `
    import { openSync, writeSync, closeSync } from 'node:fs';
    const fd = openSync(${JSON.stringify(file)}, 'r+');
    console.log('ready');
    const end = Date.now() + 2000; let turn = false;
    while (Date.now() < end) { writeSync(fd, Buffer.from((turn = !turn) ? 's' : 't'), 0, 1, ${record.indexOf("session-Alice")}); }
    closeSync(fd);
  `;
  const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], { cwd: f.dir, env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_STATE_DIR: join(home, "state") }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready"); reader.releaseLock();
  try { expect(() => migrateLegacy(f.options)).toThrow("source changed"); }
  finally { child.kill(); await child.exited; }
  expect(await new Response(child.stderr).text()).toBe("");
  expect(existsSync(f.destinationDir)).toBe(false);
});
