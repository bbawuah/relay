import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APPLICATION_ID as MESSAGE_APPLICATION_ID, SCHEMA_VERSION as MESSAGE_SCHEMA_VERSION } from "../storage/paths";
import { assertPublishCapability, publishNoReplace } from "../storage/publish";
import { fail, regular, type Snapshot } from "./source";

export type HeldAction = "quarantine" | "import" | "skip";
export type Stage = "waiting" | "pending" | "stored" | "done" | "skipped";
export type Header = { format: "relay-legacy-migration-v1"; sourceDir: string; sourceDigest: string; namespace: string; peerMapping: Record<string, string>; createdAt: number; heldAction: HeldAction; complete: boolean; quarantineTemp?: string };
const APPLICATION_ID = 0x524c4d31;
const SCHEMA = [
  "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
  "CREATE TABLE entries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, held INTEGER NOT NULL, acked INTEGER NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('waiting','pending','stored','done','skipped')))"
];
const allowed = new Set(["migration.sqlite", "migration.sqlite-journal", "messages.sqlite", "messages.sqlite-wal", "messages.sqlite-shm", "messages.sqlite-journal", "legacy-quarantine.json"]);
const quarantineName = /^\.relay-quarantine-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
// Exact B3 mkdtemp prefix. Such remnants are never opened as SQLite or adopted.
const messageInitName = /^\.relay-message-init-[A-Za-z0-9]{6}$/;

function checkMessageRemnant(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail("unsafe message initialization remnant; left intact");
  const files = new Set(["messages.sqlite", "messages.sqlite-wal", "messages.sqlite-shm", "messages.sqlite-journal"]);
  const names = readdirSync(path);
  if (names.length && !names.includes("messages.sqlite")) fail("orphan sidecar in message initialization remnant; left intact");
  for (const name of names) {
    if (!files.has(name)) fail("foreign node in message initialization remnant; left intact");
    const file = join(path, name); const item = regular(file, true);
    if (name === "messages.sqlite" && item.size > 0) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(100);
        if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== "SQLite format 3\0" || header.readUInt32BE(68) !== MESSAGE_APPLICATION_ID || header.readUInt32BE(60) !== MESSAGE_SCHEMA_VERSION) fail("foreign database in message initialization remnant; left intact");
      } finally { closeSync(fd); }
    }
  }
}

export function checkDestination(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail("destination must be an owned private directory");
  const names = readdirSync(path);
  if (!names.length) return false;
  if (!names.includes("migration.sqlite")) fail("destination is unrelated existing state");
  for (const name of names) {
    if (messageInitName.test(name)) { checkMessageRemnant(join(path, name)); continue; }
    // A candidate temp must also match the durable ledger registration below.
    if (!allowed.has(name) && !quarantineName.test(name)) fail("unknown destination file; left intact");
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
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The public ledger name is never visible until its entire own schema is durable. */
function initializeLedger(path: string, sourceDir: string, namespace: string, data: Snapshot, time: number) {
  assertPublishCapability();
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(parent, ".relay-migration-init-"));
  const temporary = join(staging, "migration.sqlite");
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd);
  const db = new Database(temporary, { create: false, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE");
    db.transaction(() => {
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
      for (const sql of SCHEMA) db.exec(sql);
      const header: Header = { format: "relay-legacy-migration-v1", sourceDir, sourceDigest: data.digest, namespace, peerMapping: data.mapping, createdAt: time, heldAction: "quarantine", complete: false };
      db.query("INSERT INTO metadata VALUES (1,?)").run(JSON.stringify(header));
      for (const entry of data.entries) db.query("INSERT INTO entries VALUES (?,?,?,?, 'waiting')").run(entry.message.id, entry.fingerprint, Number(entry.held), Number(entry.acked));
    }).immediate();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(true); }
  for (const suffix of ["-wal", "-journal"]) {
    if (existsSync(temporary + suffix) && regular(temporary + suffix, true).size !== 0) fail("private ledger still requires recovery; initialization retained outside destination");
  }
  const ready = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(ready); } finally { closeSync(ready); }
  syncDirectory(staging);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  checkDestination(path); // Refuse unrelated state that appeared during initialization.
  if (!publishNoReplace(temporary, join(path, "migration.sqlite"))) fail("ledger publication lost to an existing file; both files left intact");
  syncDirectory(staging); syncDirectory(path); syncDirectory(parent);
  rmdirSync(staging); syncDirectory(parent); // Only this call's now-empty directory.
}

export function openLedger(path: string, sourceDir: string, namespace: string, data: Snapshot, time: number, resumed: boolean) {
  if (!resumed) initializeLedger(path, sourceDir, namespace, data, time);
  const ledgerPath = join(path, "migration.sqlite");
  const db = new Database(ledgerPath, { create: false, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL");
    const actual = db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ sql: string }>;
    if (JSON.stringify(actual.map(row => row.sql)) !== JSON.stringify([SCHEMA[1], SCHEMA[0]])) fail("unknown migration ledger schema");
    const record = db.query("SELECT value FROM metadata WHERE id=1").get() as { value: string } | null;
    if (!record) return fail("corrupt migration marker");
    if ((db.query("SELECT count(*) AS n FROM metadata").get() as { n: number }).n !== 1) fail("corrupt migration marker");
    const header = JSON.parse(record.value) as Header;
    if (header.format !== "relay-legacy-migration-v1" || header.sourceDir !== sourceDir || header.sourceDigest !== data.digest || header.namespace !== namespace || JSON.stringify(header.peerMapping) !== JSON.stringify(data.mapping)
      || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 || typeof header.complete !== "boolean" || !["quarantine", "import", "skip"].includes(header.heldAction)) fail("migration source, namespace or marker conflict");
    if (header.quarantineTemp !== undefined && (typeof header.quarantineTemp !== "string" || !quarantineName.test(header.quarantineTemp))) fail("invalid quarantine registration; left intact");
    for (const name of readdirSync(path)) {
      if (quarantineName.test(name) && name !== header.quarantineTemp) fail("unregistered quarantine temporary file; left intact");
    }
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

export function ensureQuarantine(path: string, data: Snapshot, namespace: string, ledger: ReturnType<typeof openLedger>) {
  const content = Buffer.from(JSON.stringify({ format: "relay-legacy-quarantine-v1", label: "Legacy held data; never an active inbox", sourceDigest: data.digest, namespace,
    messages: data.entries.filter(entry => entry.held).map(entry => ({ envelope: entry.legacy, acknowledged: entry.acked })) }) + "\n");
  const target = join(path, "legacy-quarantine.json");
  const read = (file: string, prefix = false) => {
    const stat = regular(file, true);
    if (stat.size > content.length) fail("unknown or corrupt legacy quarantine; left intact");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (stat.dev !== opened.dev || stat.ino !== opened.ino || stat.size !== opened.size) fail("quarantine file changed while opening");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (stat.size !== bytes.length || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail("quarantine file changed while reading");
      if (!bytes.equals(prefix ? content.subarray(0, bytes.length) : content)) fail("unknown or corrupt legacy quarantine; left intact");
      return { bytes, stat };
    }
    finally { closeSync(fd); }
  };
  if (existsSync(target)) {
    read(target);
    if (ledger.header.quarantineTemp && existsSync(join(path, ledger.header.quarantineTemp))) read(join(path, ledger.header.quarantineTemp), true);
    return;
  }
  assertPublishCapability();
  if (!ledger.header.quarantineTemp) {
    ledger.header.quarantineTemp = `.relay-quarantine-${randomUUID()}.tmp`;
    ledger.save(); // FULL commit before creating even an empty temporary inode.
  }
  const temp = join(path, ledger.header.quarantineTemp);
  const previous = existsSync(temp) ? read(temp, true) : undefined;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_NOFOLLOW | (previous ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    const current = fstatSync(fd);
    if (previous && (current.dev !== previous.stat.dev || current.ino !== previous.stat.ino || current.size !== previous.bytes.length || current.mtimeMs !== previous.stat.mtimeMs || current.ctimeMs !== previous.stat.ctimeMs)) fail("quarantine temporary file changed; left intact");
    writeFileSync(fd, content.subarray(previous?.bytes.length ?? 0)); fsyncSync(fd);
  } finally { closeSync(fd); }
  read(temp);
  syncDirectory(path);
  if (!publishNoReplace(temp, target)) read(target); // EEXIST never overwrites a winner.
  syncDirectory(path);
}
