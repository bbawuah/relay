import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { MessageError } from "../messages/contracts";

export const APPLICATION_ID = 0x524c5932; // RLY2; separate from launch reservations.
export const SCHEMA_VERSION = 1;
const fail = (detail: string): never => { throw new MessageError("storage", `Unsafe message database: ${detail}`); };

function privateFile(path: string) {
  const st = lstatSync(path);
  if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077)) fail(`not a private, owned regular file: ${path}`);
  return st;
}

/** Validate before opening SQLite. Header checks identify the application only;
 * SQLite itself performs WAL/journal recovery, without a raw integrity probe. */
export function preparePath(path: string): { path: string; fresh: boolean } {
  if (!isAbsolute(path) || path === ":memory:" || path.includes("\0")) fail("an absolute local file path is required");
  path = resolve(path);
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let st;
    try { st = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 }); st = lstatSync(current);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) fail(`directory link or non-directory: ${current}`);
    // Shared sticky temporary roots are safe ancestors; the immediate parent must be private.
    if ((st.mode & 0o022) && !(st.mode & 0o1000)) fail(`writable ancestor: ${current}`);
  }
  const dir = lstatSync(parent);
  if (dir.uid !== process.getuid?.() || (dir.mode & 0o077)) fail(`parent must be owned and private: ${parent}`);
  const fsType = Number(statfsSync(parent).type) >>> 0;
  if ([0x6969, 0xff534d42, 0x517b, 0x564c, 0x73757245, 0x01021997].includes(fsType)) fail("network filesystems are unsupported");
  let existing = false;
  try { privateFile(path); existing = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { privateFile(path + suffix); if (!existing) fail(`orphan ${suffix} file`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!existing) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    return { path, fresh: true };
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = privateFile(path); const opened = fstatSync(fd);
    if (initial.dev !== opened.dev || initial.ino !== opened.ino) fail("file changed while opening");
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== "SQLite format 3\0"
      || header.readUInt32BE(68) !== APPLICATION_ID || header.readUInt32BE(60) !== SCHEMA_VERSION) fail("unknown application or schema version");
  } finally { closeSync(fd); }
  return { path, fresh: false };
}
