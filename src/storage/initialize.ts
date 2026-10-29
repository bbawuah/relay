import { closeSync, constants, fsyncSync, lstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { MessageError } from "../messages/contracts";
import { preparePath } from "./paths";
import { assertPublishCapability, publishNoReplace } from "./publish";

function syncPath(path: string, directory = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Build privately, close/checkpoint, sync, then atomically publish one complete inode. */
export function ensureMessageDatabase(path: string, initialize: (temporaryPath: string) => void): string {
  assertPublishCapability();
  for (let attempt = 0; attempt < 4; attempt++) {
    const prepared = preparePath(path);
    if (!prepared.fresh) return prepared.path;
    const parent = dirname(prepared.path);
    const temporaryDirectory = mkdtempSync(join(parent, ".relay-message-init-"));
    const temporaryPath = join(temporaryDirectory, "messages.sqlite");
    try {
      const fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      initialize(temporaryPath);
      const ready = preparePath(temporaryPath);
      if (ready.fresh) throw new MessageError("storage", "Private database initialization did not complete.");
      for (const suffix of ["-wal", "-journal"]) {
        let size = 0;
        try { size = lstatSync(temporaryPath + suffix).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (size !== 0) throw new MessageError("storage", "Private database still requires sidecar recovery; publication refused.");
      }
      syncPath(temporaryPath);
      if (publishNoReplace(temporaryPath, prepared.path)) {
        // Persist the move in both directories. A kill at any point exposes
        // either no destination or a complete, single-link database.
        syncPath(temporaryDirectory, true); syncPath(parent, true);
      }
      const winner = preparePath(prepared.path);
      if (!winner.fresh) return winner.path;
    } finally {
      // Only our unguessable private directory is cleaned. Crash remnants are
      // ignored by later opens and never treated as a trusted destination.
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  throw new MessageError("storage", "Message database publication kept changing; retry later.");
}
