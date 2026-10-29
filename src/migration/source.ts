import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import type { Envelope } from "../messages/contracts";

export const MAX_IMPORT_MESSAGES = 100_000;
export const MAX_LEGACY_BYTES = 64_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const fail = (message: string): never => { throw new Error(`Legacy migration: ${message}`); };
export type LegacyEnvelope = { id: string; van: string; naar: string; draad: string; antwoord_op?: string; ts: string; tekst: string; hop: number; herkomst: string; soort: string };
export type Imported = { message: Envelope; legacy: LegacyEnvelope; acked: boolean; held: boolean; fingerprint: string };
export type Snapshot = { digest: string; signature: string; mapping: Record<string, string>; entries: Imported[]; wide: number; orphanAcks: number };

/** Refuse links in every existing component, including symlinked ancestors. */
export function safePath(input: string, directory = true): string {
  if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0")) fail("absolute paths without NUL are required");
  const path = resolve(input);
  let current = parse(path).root;
  let canonical = current;
  const parts = path.slice(current.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(canonical, ...parts.slice(i)); throw error; }
    if (stat.isSymbolicLink() || ((i < parts.length - 1 || directory) && !stat.isDirectory())) fail("linked or non-directory path");
    if (stat.isDirectory() && (stat.mode & 0o022) && !(stat.mode & 0o1000)) fail("writable path ancestor");
    canonical = realpathSync(current);
  }
  return canonical;
}
export function regular(path: string, privateFile = false) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (privateFile && (stat.mode & 0o077))) fail("unsafe nonregular, linked, foreign or nonprivate file");
  return stat;
}
function read(path: string): { bytes: Buffer; stamp: string } {
  const initial = regular(path);
  if (initial.size > MAX_SOURCE_BYTES) fail("source file exceeds bounded snapshot quota");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (initial.dev !== before.dev || initial.ino !== before.ino) fail("source changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const stamp = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    if (stamp(before) !== stamp(after) || bytes.length !== before.size) fail("source changed while reading");
    return { bytes, stamp: stamp(after) };
  } finally { closeSync(fd); }
}
function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return fail("malformed legacy JSON"); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected a legacy object");
  return value as Record<string, unknown>;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 1024) fail("invalid legacy identifier");
}
function name(value: unknown): asserts value is string {
  if (typeof value !== "string" || !NAME.test(value)) fail("invalid legacy alias or mailbox path");
}

/** Only the old data directories are read; launch databases and hook settings are never opened. */
export function snapshot(sourceDir: string, namespace: string): Snapshot {
  const root = lstatSync(sourceDir);
  if (!root.isDirectory() || root.uid !== process.getuid?.()) fail("source must be an owned directory");
  const contents: Array<[string, Buffer, string]> = [];
  const dirs: string[] = [];
  let bytes = 0;
  const collect = (relative: string, extension: RegExp) => {
    const path = join(sourceDir, relative);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) fail("unsafe source data directory");
    dirs.push(relative);
    for (const file of readdirSync(path).sort()) {
      if (!extension.test(file)) fail("unexpected file in legacy data directory");
      const relativeFile = `${relative}/${file}`;
      const result = read(join(sourceDir, relativeFile));
      bytes += result.bytes.length;
      if (bytes > MAX_SOURCE_BYTES || contents.length >= 100_000) fail("source exceeds bounded snapshot quota");
      contents.push([relativeFile, result.bytes, result.stamp]);
    }
  };
  // Validate the intermediate peers directory even when its input subdirectories are absent.
  try { const peers = lstatSync(join(sourceDir, "peers")); if (!peers.isDirectory() || peers.isSymbolicLink()) fail("unsafe peers directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  collect("register", /\.json$/);
  collect("peers/inbox", /\.(jsonl|gelezen)$/);
  collect("peers/vastgehouden", /\.jsonl$/);
  if (!dirs.length) fail("no recognized legacy data directories");
  const aliases = new Map<string, string>();
  const addName = (value: unknown) => {
    name(value); const folded = value.toLowerCase();
    const previous = aliases.get(folded);
    if (previous !== undefined && previous !== value) fail("ambiguous case-folded aliases or mailboxes");
    aliases.set(folded, value);
  };
  const raw: Array<{ legacy: LegacyEnvelope; held: boolean }> = [];
  const acks = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const [file, buffer] of contents) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return fail("invalid UTF-8 source data"); }
    if (file.startsWith("register/")) {
      const record = object(json(text)); id(record.id);
      if (record.naam !== "") addName(record.naam);
      continue;
    }
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.(jsonl|gelezen)$/, "");
    name(base);
    // Old mailbox filenames are lowercased; display aliases need not be.
    if (base !== base.toLowerCase()) fail("ambiguous noncanonical mailbox filename");
    if (file.endsWith(".gelezen")) {
      const ids = text.split("\n"); if (ids.at(-1) === "") ids.pop();
      const values = new Set<string>(); for (const value of ids) { id(value); values.add(value); }
      acks.set(base, values); continue;
    }
    const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      const value = object(json(line));
      id(value.id); id(value.draad); name(value.van); name(value.naar);
      if (value.antwoord_op !== undefined) id(value.antwoord_op);
      if (typeof value.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.ts) || !Number.isSafeInteger(Date.parse(value.ts)) || Date.parse(value.ts) < 0 || new Date(value.ts).toISOString() !== value.ts) fail("invalid legacy timestamp");
      if (typeof value.tekst !== "string" || value.tekst.length > 16_000 || Buffer.byteLength(value.tekst, "utf8") > MAX_LEGACY_BYTES) fail("invalid or oversized legacy body");
      if (!Number.isSafeInteger(value.hop) || (value.hop as number) < 1 || !["schoon", "extern"].includes(value.herkomst as string) || !["bericht", "melding", "idle"].includes(value.soort as string)) fail("invalid legacy envelope metadata");
      if (value.naar.toLowerCase() !== base || seen.has(value.id)) fail("duplicate message ID or wrong mailbox");
      addName(value.van); addName(value.naar); seen.add(value.id);
      raw.push({ legacy: value as unknown as LegacyEnvelope, held: file.startsWith("peers/vastgehouden/") });
      if (raw.length > MAX_IMPORT_MESSAGES) fail("legacy message quota exceeded");
    }
  }
  // Empty mailboxes still have a stable address, using a register's display name if present.
  for (const [file] of contents.filter(([file]) => !file.startsWith("register/"))) {
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.(jsonl|gelezen)$/, "");
    if (!aliases.has(base)) addName(base);
  }
  const mapping = Object.fromEntries([...aliases.values()].sort().map(alias => [alias, `legacy-${hash(JSON.stringify([namespace, alias.toLowerCase()]))}`]));
  let wide = 0;
  const entries = raw.map(({ legacy, held }) => {
    const message: Envelope = { version: 2, id: legacy.id, namespace, from: mapping[legacy.van], to: mapping[legacy.naar], conversationId: legacy.draad,
      ...(legacy.antwoord_op !== undefined ? { replyTo: legacy.antwoord_op } : {}), createdAt: Date.parse(legacy.ts), body: legacy.tekst };
    if (Buffer.byteLength(message.body, "utf8") > 16_000) wide++;
    return { message, legacy, held, acked: acks.get(legacy.naar.toLowerCase())?.has(legacy.id) ?? false, fingerprint: hash(JSON.stringify(message)) };
  });
  let orphanAcks = 0;
  const byId = new Map(entries.map(entry => [entry.message.id, entry]));
  for (const [mailbox, ids] of acks) for (const ack of ids) {
    const entry = byId.get(ack);
    if (!entry) orphanAcks++;
    else if (entry.legacy.naar.toLowerCase() !== mailbox) fail("acknowledgement belongs to another mailbox");
  }
  const digest = hash(JSON.stringify([dirs, contents.map(([file, data]) => [file, hash(data)])]));
  const signature = hash(JSON.stringify(contents.map(([file, , stamp]) => [file, stamp])));
  return { digest, signature, mapping, entries, wide, orphanAcks };
}
