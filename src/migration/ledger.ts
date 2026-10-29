import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, regular, type Snapshot } from "./source";

export type HeldAction = "quarantine" | "import" | "skip";
export type Stage = "waiting" | "pending" | "stored" | "done" | "skipped";
export type Header = { format: "relay-legacy-migration-v1"; sourceDir: string; sourceDigest: string; namespace: string; peerMapping: Record<string, string>; createdAt: number; heldAction: HeldAction; complete: boolean };
const APPLICATION_ID = 0x524c4d31;
const SCHEMA = [
  "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
  "CREATE TABLE entries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, held INTEGER NOT NULL, acked INTEGER NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('waiting','pending','stored','done','skipped')))"
];
const allowed = new Set(["migration.sqlite", "migration.sqlite-journal", "messages.sqlite", "messages.sqlite-wal", "messages.sqlite-shm", "messages.sqlite-journal", "legacy-quarantine.json", "legacy-quarantine.json.tmp"]);

export function checkDestination(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail("destination must be an owned private directory");
  const names = readdirSync(path);
  if (!names.length) return false;
  if (!names.includes("migration.sqlite")) fail("destination is unrelated existing state");
  for (const name of names) {
    if (!allowed.has(name)) fail("unknown destination file; left intact");
    regular(join(path, name), true);
  }
  const ledger = join(path, "migration.sqlite");
  const fd = openSync(ledger, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(100);
    if (readSync(fd, bytes, 0, 100, 0) !== 100 || bytes.subarray(0, 16).toString() !== "SQLite format 3\0" || bytes.readUInt32BE(68) !== APPLICATION_ID || bytes.readUInt32BE(60) !== 1) fail("unknown or corrupt migration marker; left intact");
  } finally { closeSync(fd); }
  return true;
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function openLedger(path: string, sourceDir: string, namespace: string, data: Snapshot, time: number, resumed: boolean) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const ledgerPath = join(path, "migration.sqlite");
  if (!resumed) {
    const fd = openSync(ledgerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd);
  }
  const db = new Database(ledgerPath, { create: false, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL");
    if (!resumed) {
      db.transaction(() => {
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
        for (const sql of SCHEMA) db.exec(sql);
        const header: Header = { format: "relay-legacy-migration-v1", sourceDir, sourceDigest: data.digest, namespace, peerMapping: data.mapping, createdAt: time, heldAction: "quarantine", complete: false };
        db.query("INSERT INTO metadata VALUES (1,?)").run(JSON.stringify(header));
        for (const entry of data.entries) db.query("INSERT INTO entries VALUES (?,?,?,?, 'waiting')").run(entry.message.id, entry.fingerprint, Number(entry.held), Number(entry.acked));
      }).immediate();
      syncDirectory(path);
    }
    const actual = db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ sql: string }>;
    if (JSON.stringify(actual.map(row => row.sql)) !== JSON.stringify([SCHEMA[1], SCHEMA[0]])) fail("unknown migration ledger schema");
    const record = db.query("SELECT value FROM metadata WHERE id=1").get() as { value: string } | null;
    if (!record) return fail("corrupt migration marker");
    if ((db.query("SELECT count(*) AS n FROM metadata").get() as { n: number }).n !== 1) fail("corrupt migration marker");
    const header = JSON.parse(record.value) as Header;
    if (header.format !== "relay-legacy-migration-v1" || header.sourceDir !== sourceDir || header.sourceDigest !== data.digest || header.namespace !== namespace || JSON.stringify(header.peerMapping) !== JSON.stringify(data.mapping)
      || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 || typeof header.complete !== "boolean" || !["quarantine", "import", "skip"].includes(header.heldAction)) fail("migration source, namespace or marker conflict");
    const rows = db.query("SELECT * FROM entries").all() as Array<{ id: string; fingerprint: string; held: number; acked: number; stage: Stage }>;
    const expected = new Map(data.entries.map(entry => [entry.message.id, entry]));
    if (rows.length !== expected.size) fail("corrupt migration ledger entries");
    for (const row of rows) {
      const entry = expected.get(row.id);
      if (!entry || row.fingerprint !== entry.fingerprint || row.held !== Number(entry.held) || row.acked !== Number(entry.acked) || !["waiting", "pending", "stored", "done", "skipped"].includes(row.stage)) fail("conflicting migration ledger entry");
    }
    for (const row of rows) {
      if (header.complete && ((!row.held || header.heldAction === "import") ? row.stage !== "done" : row.stage !== (header.heldAction === "skip" ? "skipped" : "waiting"))) fail("corrupt migration completion state");
    }
    if (resumed && !existsSync(join(path, "messages.sqlite")) && (header.complete || rows.some(row => !["waiting", "skipped"].includes(row.stage)))) fail("migration target database is missing");
    return {
      header,
      stage(id: string): Stage { return (db.query("SELECT stage FROM entries WHERE id=?").get(id) as { stage: Stage }).stage; },
      stageAs(id: string, stage: Stage) { db.query("UPDATE entries SET stage=? WHERE id=?").run(stage, id); },
      save() { db.query("UPDATE metadata SET value=? WHERE id=1").run(JSON.stringify(header)); },
      close() { db.close(); }
    };
  } catch (error) { db.close(); throw error; }
}

export function ensureQuarantine(path: string, data: Snapshot, namespace: string) {
  const content = JSON.stringify({ format: "relay-legacy-quarantine-v1", label: "Legacy held data; never an active inbox", sourceDigest: data.digest, namespace,
    messages: data.entries.filter(entry => entry.held).map(entry => ({ envelope: entry.legacy, acknowledged: entry.acked })) }) + "\n";
  const target = join(path, "legacy-quarantine.json");
  const temp = `${target}.tmp`;
  const matches = (file: string) => {
    regular(file, true);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (readFileSync(fd, "utf8") !== content) fail("unknown or corrupt legacy quarantine; left intact"); }
    finally { closeSync(fd); }
  };
  if (existsSync(target)) { matches(target); if (existsSync(temp)) fail("unexpected quarantine temporary file; left intact"); return; }
  if (existsSync(temp)) matches(temp);
  else {
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  }
  renameSync(temp, target); syncDirectory(path);
}
