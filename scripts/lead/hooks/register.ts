// Register en inbox van de lead-hooks (staatmap, atomair schrijven, privacy).
// Geen netwerk, geen git. Alleen bestanden onder de staatmap.
//
// Staatmap: ${LAB_LEAD_STAAT:-$HOME/.local/state/lab-lead}
//   register/<id>.json     een record per sessie of subagent (tmp + rename)
//   inbox/<lead>.jsonl     meldingen voor die lead, één regel < 512 B per append
//   inbox/<lead>.gelezen   byte-offset tot waar de lead de inbox gezien heeft
//
// Er worden nooit prompttekst, tool-invoer, antwoorden of transcripts bewaard.

import { appendFileSync, closeSync, constants as FS, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { PeerVelden } from "../peers/types";
import { constants as SQLITE, Database } from "bun:sqlite";

export type Toestand = "bezig" | "idle" | "goedkeuring" | "klaar" | "vrij" | "vastgelopen" | "weg";

export type Rec = {
  id: string;
  soort: "sessie" | "subagent";
  naam: string;
  rol: string;
  lead: string;
  opdracht: string;
  cwd: string;
  pane: string;
  toestand: Toestand;
  sinds: number;
  start: number;
  einde: number | null;
  laatste_tool: string | null;
  laatste_tool_om: number | null;
  tools_in_beurt: number;
  rapport_om: number | null;
  rapport_in_beurt: boolean;
  vrij: boolean;
  /** Tot wanneer de sessie op een achtergrondrun wacht (ms); tot dan geen idle- of 3×-melding. */
  wacht_tot?: number | null;
  blokkades: number;
  ouder: string | null;
  agent_type: string | null;
  /** Eenmalig id van spawn.sh (LAB_SPAWN_ID); een kindproces dat de omgeving erft, deelt het en telt niet als sessie. */
  spawn_id?: string;
  /** Gezet door hernoem.ts: naam/lead zijn bewust gewijzigd en gaan mee bij /clear. */
  hernoemd?: boolean;
  /** Aantal ongelezen peer-berichten bij het laatste seintje (UserPromptSubmit of Stop): Stop blokkeert alleen bij een stijging. */
  seintje_n?: number;
} & PeerVelden;

export type Omgeving = { [k: string]: string | undefined };

export const MAX_INBOX_REGELS = 50;
export const MAX_REGEL_BYTES = 511;

export function staatMap(env: Omgeving): string {
  return env.LAB_LEAD_STAAT || join(env.HOME || homedir(), ".local/state/lab-lead");
}

/** Maakt een naam veilig voor gebruik als bestandsnaam. */
export function veilig(s: string): string {
  return (s || "onbekend").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "onbekend";
}

export function zorgVoorMappen(staat: string): void {
  mkdirSync(join(staat, "register"), { recursive: true, mode: 0o700 });
  mkdirSync(join(staat, "inbox"), { recursive: true, mode: 0o700 });
}

function schrijfAtomair(pad: string, inhoud: string): void {
  const tmp = `${pad}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, inhoud, { mode: 0o600 });
  renameSync(tmp, pad);
}

export function recordPad(staat: string, id: string): string {
  return join(staat, "register", `${veilig(id)}.json`);
}

export function leesRecord(staat: string, id: string): Rec | null {
  try {
    const r = JSON.parse(readFileSync(recordPad(staat, id), "utf8"));
    return r && typeof r === "object" ? (r as Rec) : null;
  } catch {
    return null;
  }
}

export function schrijfRecord(staat: string, r: Rec): void {
  zorgVoorMappen(staat);
  schrijfAtomair(recordPad(staat, r.id), `${JSON.stringify(r)}\n`);
}

export function nieuwRecord(id: string, env: Omgeving, cwd: string, nu: number): Rec {
  return {
    id,
    soort: "sessie",
    naam: env.LAB_AGENT_NAAM || "",
    rol: env.LAB_AGENT_ROL || "",
    lead: env.LAB_LEAD_NAAM || "",
    opdracht: env.LAB_OPDRACHT || "",
    cwd,
    pane: env.TMUX_PANE || "",
    toestand: "bezig",
    sinds: nu,
    start: nu,
    einde: null,
    laatste_tool: null,
    laatste_tool_om: null,
    tools_in_beurt: 0,
    rapport_om: null,
    rapport_in_beurt: false,
    vrij: false,
    blokkades: 0,
    ouder: null,
    agent_type: null,
    ...(env.LAB_SPAWN_ID ? { spawn_id: env.LAB_SPAWN_ID } : {}),
  };
}

/**
 * Is `sessieId` een kindproces van een andere, levende sessie met hetzelfde spawn-id? Bijvoorbeeld een `claude -p` die een
 * agent start en LAB_AGENT_NAAM, LAB_LEAD_NAAM en LAB_SPAWN_ID erft. Een eigenaar telt als levend als hij niet `weg` is en
 * de laatste activiteit jonger is dan `verouderdMs` (een gecrashte sessie blokkeert een herstart niet voor altijd).
 */
export function isKindProces(staat: string, spawnId: string, sessieId: string, nu: number, verouderdMs = 12 * 3600_000): boolean {
  if (!spawnId) return false;
  return alleRecords(staat).some(
    (r) => r.soort === "sessie" && r.spawn_id === spawnId && r.id !== sessieId && r.toestand !== "weg" && nu - Math.max(r.sinds, r.laatste_tool_om ?? 0) < verouderdMs,
  );
}

/** Leest een record; een ontbrekend of kapot record wordt een vers record uit de omgeving. */
export function leesOfMaak(staat: string, id: string, env: Omgeving, cwd: string, nu: number): Rec {
  const oud = leesRecord(staat, id);
  const vers = nieuwRecord(id, env, cwd, nu);
  return oud ? { ...vers, ...oud } : vers;
}

export function zetToestand(r: Rec, t: Toestand, nu: number): void {
  if (r.toestand !== t) r.sinds = nu;
  r.toestand = t;
}

export function alleRecords(staat: string): Rec[] {
  const uit: Rec[] = [];
  let namen: string[] = [];
  try {
    namen = readdirSync(join(staat, "register"));
  } catch {
    return uit;
  }
  for (const n of namen) {
    if (!n.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(staat, "register", n), "utf8"));
      if (r && typeof r === "object" && typeof r.id === "string") uit.push(r as Rec);
    } catch {
      // kapot record: negeren
    }
  }
  return uit;
}

/** Subagents van deze sessie die nog lopen (en niet al uren stil zijn). */
export function lopendeSubagents(staat: string, sessieId: string, nu: number, verouderdMs = 2 * 3600_000): Rec[] {
  return alleRecords(staat).filter(
    (r) => r.soort === "subagent" && r.ouder === sessieId && r.toestand === "bezig" && nu - (r.laatste_tool_om ?? r.sinds) < verouderdMs,
  );
}

// ---- inbox ----

export function inboxPad(staat: string, lead: string): string {
  return join(staat, "inbox", `${veilig(lead)}.jsonl`);
}
function gelezenPad(staat: string, lead: string): string {
  return join(staat, "inbox", `${veilig(lead)}.gelezen`);
}

function kapAf(s: string, maxBytes: number): string {
  let uit = s;
  while (Buffer.byteLength(uit) > maxBytes) uit = uit.slice(0, -1);
  return uit;
}

/** Eén regel naar de inbox van `lead`. Zonder lead gebeurt er niets. */
export function inboxMelding(staat: string, lead: string, van: string, tekst: string, nu: number): void {
  if (!lead) return;
  zorgVoorMappen(staat);
  const vanVeilig = kapAf(van, 60);
  const basis = JSON.stringify({ t: nu, van: vanVeilig, tekst: "" });
  const ruimte = MAX_REGEL_BYTES - Buffer.byteLength(basis) - 16; // marge voor JSON-escapes
  const regel = JSON.stringify({ t: nu, van: vanVeilig, tekst: kapAf(tekst, Math.max(20, ruimte)) });
  appendFileSync(inboxPad(staat, lead), `${regel}\n`, { mode: 0o600 });
}

export function inboxGrootte(staat: string, lead: string): number {
  try {
    return statSync(inboxPad(staat, lead)).size;
  } catch {
    return 0;
  }
}

export function gelezenOffset(staat: string, lead: string): number {
  try {
    const n = Number.parseInt(readFileSync(gelezenPad(staat, lead), "utf8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function zetGelezen(staat: string, lead: string, offset: number): void {
  zorgVoorMappen(staat);
  schrijfAtomair(gelezenPad(staat, lead), `${offset}\n`);
}

export type InboxRegel = { t: number; van: string; tekst: string };

/** Ongelezen regels (hoogstens `max`), het aantal dat er extra was en de nieuwe offset (einde van de laatste volledige regel). */
export function leesOngelezen(staat: string, lead: string, max = MAX_INBOX_REGELS): { regels: InboxRegel[]; meer: number; einde: number } {
  const pad = inboxPad(staat, lead);
  if (!existsSync(pad)) return { regels: [], meer: 0, einde: 0 };
  const buf = readFileSync(pad);
  let van = gelezenOffset(staat, lead);
  if (van > buf.length) van = 0; // bestand is korter geworden: opnieuw beginnen
  const einde = buf.lastIndexOf(0x0a) + 1; // alleen volledige regels
  if (einde <= van) return { regels: [], meer: 0, einde: van };
  const stuk = buf.subarray(van, einde).toString("utf8").split("\n").filter((l) => l.trim());
  const regels: InboxRegel[] = [];
  for (const l of stuk) {
    try {
      const o = JSON.parse(l);
      regels.push({ t: Number(o.t) || 0, van: String(o.van ?? ""), tekst: String(o.tekst ?? "") });
    } catch {
      // kapotte regel overslaan
    }
  }
  return { regels: regels.slice(0, max), meer: Math.max(0, regels.length - max), einde };
}

/**
 * Leest de ongelezen regels en zet de offset in één stap vooruit. Een tweede lezer die tegelijk binnenkomt (Stop-hook en
 * wekker) krijgt niets: een slotmap (mkdir is atomair) zorgt dat elke regel één keer wordt afgeleverd. Identieke regels
 * (zelfde afzender en tekst) in één batch tellen eenmaal. Een slot ouder dan 10 s is van een gecrashte lezer.
 */
export function pakOngelezen(staat: string, lead: string, nu: number, max = MAX_INBOX_REGELS): { regels: InboxRegel[]; meer: number; einde: number } {
  const leeg = { regels: [], meer: 0, einde: gelezenOffset(staat, lead) };
  zorgVoorMappen(staat);
  const slot = `${gelezenPad(staat, lead)}.slot`;
  try {
    mkdirSync(slot, { mode: 0o700 });
  } catch {
    try {
      if (nu - statSync(slot).mtimeMs < 10_000) return leeg;
      rmSync(slot, { recursive: true, force: true });
      mkdirSync(slot, { mode: 0o700 });
    } catch {
      return leeg;
    }
  }
  try {
    const o = leesOngelezen(staat, lead, Number.MAX_SAFE_INTEGER);
    if (o.einde > gelezenOffset(staat, lead)) zetGelezen(staat, lead, o.einde);
    const gezien = new Set<string>();
    const uniek = o.regels.filter((r) => {
      const k = `${r.van}\u0000${r.tekst}`;
      return gezien.has(k) ? false : (gezien.add(k), true);
    });
    return { regels: uniek.slice(0, max), meer: Math.max(0, uniek.length - max), einde: o.einde };
  } finally {
    rmSync(slot, { recursive: true, force: true });
  }
}

export function tijd(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function regelsTekst(r: { regels: InboxRegel[]; meer: number }): string {
  const t = r.regels.map((x) => `${x.van}: ${x.tekst} ${tijd(x.t)}`).join("; ");
  return r.meer > 0 ? `${t}; +${r.meer} meer` : t;
}

// ---- leadnamen ----

/** Naam van de lead zoals het register die kent; env (`LAB_AGENT_NAAM`) is alleen de beginwaarde. */
export function eigenLeadNaam(rec: Rec | null, env: Omgeving): string {
  return rec?.naam || env.LAB_AGENT_NAAM || env.LAB_LEAD_NAAM || "lead";
}

/** Naam van de lead van een agent: het record wint, env (`LAB_LEAD_NAAM`) is de beginwaarde. */
export function meldAdres(rec: Rec | null, env: Omgeving): string {
  return rec?.lead || env.LAB_LEAD_NAAM || "";
}

/** Pane-ids die tmux nu kent; null als dat niet te achterhalen is (dan telt elke pane als bestaand). */
export function tmuxPanes(): Set<string> | null {
  try {
    const p = Bun.spawnSync(["tmux", "list-panes", "-a", "-F", "#{pane_id}"], { stdout: "pipe", stderr: "ignore" });
    if (p.exitCode !== 0) return null;
    return new Set(p.stdout.toString().split("\n").map((x) => x.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/** Levende lead-records: niet `weg`, en de pane bestaat nog (of is onbekend); zonder pane alleen als `sinds` jonger is dan 24 uur. */
export function levendeLeads(staat: string, panes: Set<string> | null, nu = Date.now()): Rec[] {
  const kand = alleRecords(staat).filter((r) => r.soort === "sessie" && r.rol === "lead" && r.toestand !== "weg" && (r.pane ? !panes || panes.has(r.pane) : nu - r.sinds < 24 * 3600_000));
  // Panes worden hergebruikt: per pane telt alleen het record met de jongste start.
  const jongste = new Map<string, number>();
  for (const r of kand) if (r.pane) jongste.set(r.pane, Math.max(jongste.get(r.pane) ?? 0, r.start));
  return kand.filter((r) => !r.pane || jongste.get(r.pane) === r.start);
}

/** Andere levende leads met dezelfde naam als `naam` (het eigen record, `eigenId`, telt niet mee). */
export function dubbeleLeads(staat: string, naam: string, eigenId: string, panes: Set<string> | null, nu = Date.now()): Rec[] {
  return levendeLeads(staat, panes, nu).filter((r) => r.naam === naam && r.id !== eigenId);
}

/** /clear geeft een nieuw session_id: het jongste hernoemde record in dezelfde pane met dezelfde rolsoort (lead of niet), levend of net `weg`. */
export function voorgangerInPane(staat: string, pane: string, isLead: boolean, eigenId: string, nu: number): Rec | null {
  if (!pane) return null;
  const k = alleRecords(staat).filter(
    (r) => r.soort === "sessie" && r.id !== eigenId && r.pane === pane && (r.rol === "lead") === isLead && r.hernoemd === true && (r.toestand !== "weg" || (r.einde !== null && nu - r.einde < 60_000)),
  );
  return k.sort((a, b) => b.start - a.start)[0] ?? null;
}

/** Markering van de bus (<staat>/peers/extern/<naam>): de sessie las externe inhoud. SessionStart (ook /clear) wist hem. */
export function externMarkering(staat: string, naam: string): string {
  return join(staat, "peers", "extern", veilig(naam));
}

export function wisExternMarkering(staat: string, naam: string): void {
  if (!naam) return;
  rmSync(externMarkering(staat, naam), { force: true });
}

// ---- identiteit per checkout (hooks van Codex erven de omgeving van de app-server-daemon, niet van de sessie) ----

/** A PID alone can be reused. Keep the OS process birth time as well. */
export type LauncherOwner = { pid: number; start: string };

export function isLauncherOwner(value: unknown): value is LauncherOwner {
  const owner = value as LauncherOwner | null;
  return !!owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.start === "string" && !!owner.start.trim();
}

function processInfo(pid: number): { start: string; zombie: boolean } | null {
  const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "lstart=", "-o", "stat="], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdout: "pipe", stderr: "ignore", timeout: 1000 });
  if (result.exitCode !== 0) return null;
  const match = result.stdout.toString().trim().match(/^(.*?)\s+(\S+)$/);
  return match ? { start: match[1]!.trim(), zombie: match[2]!.startsWith("Z") } : null;
}

export function launcherOwner(): LauncherOwner {
  const info = processInfo(process.pid);
  if (!info || info.zombie) throw new Error("cannot verify Relay launcher ownership");
  return { pid: process.pid, start: info.start };
}

export function ownerStatus(owner: LauncherOwner): "alive" | "dead" | "unknown" {
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
  const info = processInfo(owner.pid);
  if (!info) return "unknown";
  return info.zombie || info.start !== owner.start ? "dead" : "alive";
}

const LEASE_APP_ID = 0x524c5931;
const LEASE_SCHEMA = "CREATE TABLE leases (spawn TEXT PRIMARY KEY, payload TEXT NOT NULL)";
type FileIdentity = { dev: number; ino: number };
type LeaseMarker = { kind: "relay-launchers-v1"; database: FileIdentity; journal: FileIdentity };
const leaseError = (reason: string): Error => new Error(`unsafe Relay reservation database: ${reason}; preserving existing state`);

/** Inspect all existing parents before mkdir. Canonical root-owned OS aliases
 * such as macOS /var are allowed; symlinks anywhere below them are refused. */
function leaseDirectory(state: string, leaf = "launchers"): string {
  const absolute = resolve(state, leaf);
  let current = parse(absolute).root;
  let missing = false;
  for (const part of absolute.slice(current.length).split("/")) {
    current = join(current, part);
    if (missing) continue;
    let st;
    try { st = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing = true; continue; } throw leaseError("cannot inspect parent"); }
    if (st.isSymbolicLink()) {
      if (dirname(current) !== "/" || st.uid !== 0) throw leaseError("symlink parent");
      current = realpathSync(current);
    } else if (!st.isDirectory()) throw leaseError("parent is not a directory");
  }
  return current;
}

function privateLeaseFile(path: string): { bytes: Buffer; identity: FileIdentity } {
  let fd: number;
  try { fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK); }
  catch { throw leaseError("missing or symlink file"); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw leaseError("file is not private and exclusively owned");
    return { bytes: readFileSync(fd), identity: { dev: st.dev, ino: st.ino } };
  } finally { closeSync(fd); }
}

function initializeLeaseDirectory(directory: string): void {
  try { lstatSync(directory); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(directory), ".relay-launchers-"));
  try {
    const initial = new Database(":memory:");
    try {
      initial.exec(`PRAGMA application_id = ${LEASE_APP_ID}; PRAGMA user_version = 1; ${LEASE_SCHEMA}`);
      writeFileSync(join(temporary, "leases.sqlite"), initial.serialize(), { mode: 0o600, flag: "wx" });
    } finally { initial.close(); }
    writeFileSync(join(temporary, "leases.sqlite-journal"), "", { mode: 0o600, flag: "wx" });
    const marker: LeaseMarker = { kind: "relay-launchers-v1", database: privateLeaseFile(join(temporary, "leases.sqlite")).identity, journal: privateLeaseFile(join(temporary, "leases.sqlite-journal")).identity };
    writeFileSync(join(temporary, "owner.json"), JSON.stringify(marker), { mode: 0o600, flag: "wx" });
    try { renameSync(temporary, directory); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Validate bytes in memory: never let SQLite recover or initialize an unknown file. */
function verifyLeaseDatabase(directory: string): void {
  if (!eigenPrive(directory, true)) throw leaseError("reservation directory is not private");
  let marker: LeaseMarker;
  try { marker = JSON.parse(privateLeaseFile(join(directory, "owner.json")).bytes.toString()); }
  catch { throw leaseError("unknown ownership marker"); }
  if (marker?.kind !== "relay-launchers-v1") throw leaseError("unknown ownership marker");
  const path = join(directory, "leases.sqlite");
  for (const suffix of ["-wal", "-shm"]) {
    try { lstatSync(path + suffix); throw leaseError(`unknown ${suffix} sidecar`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const database = privateLeaseFile(path);
  const journal = privateLeaseFile(path + "-journal");
  const same = (actual: FileIdentity, expected: FileIdentity | undefined) => expected && actual.dev === expected.dev && actual.ino === expected.ino;
  if (!same(database.identity, marker.database) || !same(journal.identity, marker.journal)) throw leaseError("unknown database or journal inode");
  // PERSIST journals are either empty/invalidated (all-zero header), or have the
  // SQLite rollback-journal signature. Their registered inode proves provenance.
  const header = journal.bytes.subarray(0, 8);
  if (journal.bytes.length && (journal.bytes.length < 512 || (!header.every((byte) => byte === 0) && header.toString("hex") !== "d9d505f920a163d7"))) throw leaseError("corrupt journal");
  // Relay never ATTACHes another database. A master-journal trailer can name a
  // file outside this state directory and must never reach SQLite recovery.
  if (journal.bytes.length >= 16 && journal.bytes.subarray(-8).toString("hex") === "d9d505f920a163d7") throw leaseError("unsupported super-journal");
  if (database.bytes[18] !== 1 || database.bytes[19] !== 1) throw leaseError("unsupported journal mode");
  let copy: Database | undefined;
  try {
    copy = Database.deserialize(database.bytes, true);
    const app = copy.query("PRAGMA application_id").get() as { application_id: number };
    const version = copy.query("PRAGMA user_version").get() as { user_version: number };
    const schema = copy.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as { type: string; name: string; sql: string }[];
    const integrity = copy.query("PRAGMA quick_check").get() as { quick_check: string };
    if (app.application_id !== LEASE_APP_ID || version.user_version !== 1 || schema.length !== 1 || schema[0]?.type !== "table" || schema[0]?.name !== "leases" || schema[0]?.sql !== LEASE_SCHEMA || integrity.quick_check !== "ok") throw leaseError("unknown application or schema");
  } catch { throw leaseError("unknown or corrupt database/schema"); }
  finally { copy?.close(); }
}

/** SQLite supplies a crash-released, cross-process lock. Only registered files
 * are opened, with NOFOLLOW, and PERSIST keeps the journal inode recognizable. */
export function withLaunchLock<T>(state: string, action: (db: Database) => T): T {
  return launchLock(state, action, 2000);
}

function launchLock<T>(state: string, action: (db: Database) => T, waitMs: number): T {
  const directory = leaseDirectory(state);
  initializeLeaseDirectory(directory);
  verifyLeaseDatabase(directory);
  const db = new Database(join(directory, "leases.sqlite"), SQLITE.SQLITE_OPEN_READWRITE | SQLITE.SQLITE_OPEN_NOFOLLOW);
  try {
    db.exec(`PRAGMA busy_timeout = ${waitMs}; PRAGMA journal_mode = PERSIST; BEGIN IMMEDIATE`);
    try {
      const result = action(db);
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

/** Legacy-identiteiten verlopen na deze tijd; Relay-identiteiten volgen hun proces-eigenaar. */
export const IDENTITEIT_MAX_MS = 12 * 3600_000;

export type Identiteit = { naam: string; rol: string; lead: string; opdracht: string; spawn_id: string; ts: number; t3_thread?: string; sessie_id?: string; relay_owner?: LauncherOwner };

export function identiteitPad(staat: string, cwd: string): string {
  return join(staat, "identiteit", `${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}.json`);
}

/** Door spawn.sh --vendor codex: de identiteit van de sessie in deze checkout, voor codex-wrap (modus 600 in een map 700). */
export function schrijfIdentiteit(staat: string, cwd: string, i: Identiteit): void {
  withIdentityLock(staat, () => schrijfAtomair(identiteitPad(staat, cwd), `${JSON.stringify(i)}\n`));
}

/** Shared by legacy and managed identity writers. Publish a nonempty directory
 * atomically, so every visible lock has an immutable PID/birth-time token.
 * Reclaim only that dead token; rmdir cannot delete a new owner's nonempty lock.
 * Legacy maintenance never opens or creates the reservation database. */
function withIdentityLock<T>(state: string, action: () => T, waitMs = 2000): T {
  const directory = leaseDirectory(state, "identiteit");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!eigenPrive(directory, true)) throw new Error("unsafe Relay identity directory; preserving state");
  const temporary = mkdtempSync(join(directory, ".claim-"));
  const token = crypto.randomUUID();
  const slot = join(directory, ".maintenance-lock");
  let acquired = false;
  try {
    writeFileSync(join(temporary, token), JSON.stringify(launcherOwner()), { mode: 0o600, flag: "wx" });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { renameSync(temporary, slot); acquired = true; break; }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
      try {
        const st = lstatSync(slot);
        if (!st.isDirectory() || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new Error("unsafe Relay identity lock; preserving state");
        const tokens = readdirSync(slot);
        if (tokens.length === 1 && /^[0-9a-f-]{36}$/.test(tokens[0]!)) {
          const path = join(slot, tokens[0]!);
          let owner;
          try { owner = JSON.parse(privateLeaseFile(path).bytes.toString()); }
          catch (error) { if (!existsSync(path)) continue; throw error; }
          if (isLauncherOwner(owner) && ownerStatus(owner) === "dead") {
            unlinkSync(path);
            try { rmdirSync(slot); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
            continue;
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Date.now() >= deadline) throw new Error("Relay identity maintenance lock timed out; preserving state");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return action();
  } finally {
    if (acquired) {
      unlinkSync(join(slot, token));
      try { rmdirSync(slot); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
    } else rmSync(temporary, { recursive: true, force: true });
  }
}

/** hook.sh suppresses exit-0 stderr. Preserve the first upkeep failure per spawn
 * as a private, exclusive diagnostic; never follow a symlink or replace a file.
 * No identity, prompt or argv data is recorded. Unsafe paths remain stderr-only. */
export function logIdentiteitOnderhoudFout(state: string, spawnId: string, message: string): void {
  try {
    const directory = leaseDirectory(state, "identiteit");
    if (!eigenPrive(directory, true)) return;
    const key = createHash("sha256").update(spawnId).digest("hex").slice(0, 24);
    writeFileSync(join(directory, `maintenance-${key}.error`), `${JSON.stringify({ kind: "relay-identity-maintenance-error-v1", at: Date.now(), message: message.slice(0, 256) })}\n`, { mode: 0o600, flag: "wx" });
  } catch { /* Diagnostics must not replace core work or write through unsafe paths. */ }
}

/** Rollen die een gespawnde werker kan hebben; "lead" of iets anders in het bestand is nooit geldig (geen escalatie via het bestand). */
const IDENTITEIT_ROLLEN = ["agent", "sublead", "vervolg", "lead-proef"];

/** Een gewoon bestand (geen symlink), van de eigen gebruiker, zonder rechten voor groep of anderen. */
function eigenPrive(pad: string, map: boolean): boolean {
  try {
    const st = lstatSync(pad);
    if (map ? !st.isDirectory() : !st.isFile()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    return (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function leesIdentiteitBestand(pad: string, nu: number, controleerLeven = true): Identiteit | null {
  try {
    if (!eigenPrive(dirname(pad), true) || !eigenPrive(pad, false)) return null;
    const o = JSON.parse(readFileSync(pad, "utf8"));
    if (!o || typeof o !== "object" || typeof o.naam !== "string" || !o.naam || !IDENTITEIT_ROLLEN.includes(o.rol)) return null;
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts) || o.ts > nu) return null;
    if ("relay_owner" in o) {
      if (!isLauncherOwner(o.relay_owner) || typeof o.spawn_id !== "string" || !o.spawn_id) return null;
      if (controleerLeven && ownerStatus(o.relay_owner) !== "alive") return null;
    } else if (nu - o.ts > IDENTITEIT_MAX_MS) return null;
    return { naam: o.naam, rol: o.rol, lead: String(o.lead ?? ""), opdracht: String(o.opdracht ?? ""), spawn_id: String(o.spawn_id ?? ""), ts: o.ts, ...(o.relay_owner ? { relay_owner: o.relay_owner } : {}), ...(typeof o.t3_thread === "string" && o.t3_thread ? { t3_thread: o.t3_thread } : {}), ...(typeof o.sessie_id === "string" && o.sessie_id ? { sessie_id: o.sessie_id } : {}) };
  } catch {
    return null;
  }
}

export function leesIdentiteit(staat: string, cwd: string, nu = Date.now()): Identiteit | null {
  return leesIdentiteitBestand(identiteitPad(staat, cwd), nu);
}

/** Zoekt de identiteit voor `cwd` of een bovenliggende map (een sessie kan in een submap van de checkout draaien). */
export function zoekIdentiteit(staat: string, cwd: string, nu = Date.now()): { pad: string; identiteit: Identiteit } | null {
  for (let d = cwd; d && d !== "/" && d !== "."; d = dirname(d)) {
    let echt = d;
    try {
      echt = realpathSync(d); // spawn.sh hasht het echte pad van de checkout (macOS: /var is /private/var)
    } catch {}
    const pad = identiteitPad(staat, echt);
    const identiteit = leesIdentiteitBestand(pad, nu);
    if (identiteit) return { pad, identiteit };
  }
  return null;
}

/** Behoud legacy/onbekende bestanden; alleen een aantoonbaar dode Relay-eigenaar blokkeert niet meer. */
// Dode Relay-eigenaars blokkeren standaard geen nieuwe launch. MCP kan fysieke
// aanwezigheid blijven tellen om nooit op een geërfde omgevingsnaam terug te vallen.
export function heeftIdentiteitsbestand(staat: string, cwd: string, ookDodeLaunchers = false): boolean {
  for (let d = cwd; d && d !== "/" && d !== "."; d = dirname(d)) {
    let echt = d;
    try {
      echt = realpathSync(d);
    } catch {}
    try {
      const pad = identiteitPad(staat, echt);
      lstatSync(pad);
      const owned = leesIdentiteitBestand(pad, Date.now(), false);
      if (!ookDodeLaunchers && owned?.relay_owner && ownerStatus(owned.relay_owner) === "dead") continue;
      return true;
    } catch (e) {
      // alleen "bestaat niet" is een nee; elke andere fout (rechten, I/O) telt als aanwezig (faalt dicht)
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

/** Alleen onder withLaunchLock: verwijder aantoonbaar dode Relay-launchers, nooit legacy/onbekende bestanden. */
export function ruimDodeLauncherIdentiteitenOp(staat: string): string[] {
  const map = join(staat, "identiteit");
  if (!eigenPrive(map, true)) return [];
  return withIdentityLock(staat, () => {
    const spawns: string[] = [];
    for (const naam of readdirSync(map)) {
      if (!naam.endsWith(".json")) continue;
      const pad = join(map, naam);
      const identiteit = leesIdentiteitBestand(pad, Date.now(), false);
      if (!identiteit?.relay_owner || ownerStatus(identiteit.relay_owner) !== "dead") continue;
      rmSync(pad);
      spawns.push(identiteit.spawn_id);
    }
    return spawns;
  });
}

/** Alleen onder withLaunchLock; ook een verlopen eigen identiteit mag bij launcher-exit weg. */
export function wisLauncherIdentiteit(staat: string, cwd: string, spawnId: string, owner: LauncherOwner = launcherOwner()): void {
  withIdentityLock(staat, () => {
    const pad = identiteitPad(staat, cwd);
    const identiteit = leesIdentiteitBestand(pad, Date.now(), false);
    if (identiteit?.relay_owner && identiteit.spawn_id === spawnId && identiteit.relay_owner.pid === owner.pid && identiteit.relay_owner.start === owner.start) rmSync(pad, { force: true });
  });
}

/** Only under the reservation lock, before the bootstrap starts its vendor. */
export function claimLauncherIdentiteit(staat: string, cwd: string, spawnId: string, previous: LauncherOwner, owner: LauncherOwner): void {
  withIdentityLock(staat, () => {
    const pad = identiteitPad(staat, cwd);
    const identiteit = leesIdentiteitBestand(pad, Date.now(), false);
    if (!identiteit || identiteit.spawn_id !== spawnId || identiteit.relay_owner?.pid !== previous.pid || identiteit.relay_owner.start !== previous.start) throw new Error("Relay session identity changed or disappeared before bootstrap");
    schrijfAtomair(pad, `${JSON.stringify({ ...identiteit, relay_owner: owner })}\n`);
  });
}

/** Houdt de identiteit van een levende sessie vers (ts = nu): hij verloopt alleen na IDENTITEIT_MAX_MS zonder activiteit. */
export function ververseIdentiteit(staat: string, cwd: string, spawnId: string, nu = Date.now()): void {
  if (!spawnId) return;
  const found = zoekIdentiteit(staat, cwd, nu);
  if (!found || found.identiteit.spawn_id !== spawnId || nu - found.identiteit.ts <= 60_000) return;
  const refresh = () => withIdentityLock(staat, () => {
    const g = zoekIdentiteit(staat, cwd, nu);
    if (g && g.identiteit.spawn_id === spawnId && !!g.identiteit.relay_owner === !!found.identiteit.relay_owner && nu - g.identiteit.ts > 60_000) schrijfAtomair(g.pad, `${JSON.stringify({ ...g.identiteit, ts: nu })}\n`);
  }, 0);
  if (found.identiteit.relay_owner) launchLock(staat, refresh, 0);
  else refresh();
}

/** Bindt de werkruimte-identiteit van een proeflead eenmalig aan haar Codex-sessie. Andere sessies mogen haar nooit overnemen. */
export function bindLeadProefSessie(staat: string, cwd: string, spawnId: string, sessieId: string, nu = Date.now()): boolean {
  if (!spawnId || !sessieId) return false;
  const found = zoekIdentiteit(staat, cwd, nu);
  if (!found || found.identiteit.rol !== "lead-proef" || found.identiteit.spawn_id !== spawnId) return false;
  return withIdentityLock(staat, () => {
    const g = zoekIdentiteit(staat, cwd, nu);
    if (!g || g.identiteit.rol !== "lead-proef" || g.identiteit.spawn_id !== spawnId) return false;
    if (g.identiteit.sessie_id && g.identiteit.sessie_id !== sessieId) return false;
    if (!g.identiteit.sessie_id) schrijfAtomair(g.pad, `${JSON.stringify({ ...g.identiteit, sessie_id: sessieId })}\n`);
    return true;
  });
}

/** SessionEnd: haalt de identiteit weg als hij nog van deze spawn is (een nieuwe spawn in dezelfde checkout blijft staan). */
export function wisIdentiteit(staat: string, cwd: string, spawnId: string, nu = Date.now()): void {
  if (!spawnId) return;
  const found = zoekIdentiteit(staat, cwd, nu);
  if (!found || found.identiteit.spawn_id !== spawnId || found.identiteit.rol === "lead-proef") return;
  const remove = () => withIdentityLock(staat, () => {
    const g = zoekIdentiteit(staat, cwd, nu);
    if (g && g.identiteit.rol !== "lead-proef" && g.identiteit.spawn_id === spawnId && !!g.identiteit.relay_owner === !!found.identiteit.relay_owner) rmSync(g.pad, { force: true });
  }, 0);
  if (found.identiteit.relay_owner) launchLock(staat, remove, 0);
  else remove();
}
