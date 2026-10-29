import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse } from "node:path";
import { MessageError } from "../messages/contracts";

type Publisher = (source: Buffer, destination: Buffer) => number;
let native: { rename: Publisher; errno: () => number } | undefined;
const unavailable = (): never => { throw new MessageError("storage", "Atomic message database publication is unavailable on this platform."); };

function linuxLibc(): string {
  const architecture = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : unavailable();
  // Absolute OS paths only: never search cwd, LD_LIBRARY_PATH or project libraries.
  // Debian/Ubuntu multiarch and Fedora/RHEL glibc layouts. Musl is unsupported.
  const paths = [`/lib/${architecture}-linux-gnu/libc.so.6`, "/lib64/libc.so.6", "/usr/lib64/libc.so.6"];
  for (const candidate of paths) {
    let resolved: string;
    try { resolved = realpathSync(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return unavailable(); }
    if (!["/lib/", "/lib64/", "/usr/lib/", "/usr/lib64/"].some(root => resolved.startsWith(root))) return unavailable();
    let current = parse(resolved).root;
    for (const part of resolved.slice(current.length).split("/")) {
      current = join(current, part); const stat = lstatSync(current);
      if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink()) return unavailable();
    }
    if (!lstatSync(resolved).isFile()) return unavailable();
    return resolved;
  }
  return unavailable();
}

/** Load the actual no-replace entry point before touching the destination path. */
export function assertPublishCapability(): void {
  if (native) return;
  // Loader redirection can override even an absolute dlopen path on some OSes.
  // Refuse it; never inspect values or change the caller's environment.
  if (Object.keys(process.env).some(key => key.startsWith("DYLD_") || ["LD_LIBRARY_PATH", "LD_PRELOAD", "LD_AUDIT", "LD_ORIGIN_PATH"].includes(key))) unavailable();
  if (process.arch !== "x64" && process.arch !== "arm64") unavailable();
  try {
    if (process.platform === "darwin") {
      // This absolute path names Apple's protected dyld shared-cache OS library.
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr },
      });
      native = { rename: (a,b) => library.symbols.renamex_np(ptr(a),ptr(b),0x4), errno: () => read.i32(library.symbols.__error()!) };
    } else if (process.platform === "linux") {
      const library = dlopen(linuxLibc(), {
        renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      native = { rename: (a,b) => library.symbols.renameat2(-100,ptr(a),-100,ptr(b),1), errno: () => read.i32(library.symbols.__errno_location()!) };
    } else unavailable();
  } catch { unavailable(); }
}

/** Atomic move with no overwrite and no intermediate extra hardlink. */
export function publishNoReplace(source: string, destination: string): boolean {
  assertPublishCapability();
  if (!isAbsolute(source) || !isAbsolute(destination) || source.includes("\0") || destination.includes("\0")) {
    throw new MessageError("storage", "Invalid atomic publication path.");
  }
  const from = Buffer.from(source + "\0", "utf8"); const to = Buffer.from(destination + "\0", "utf8");
  const result = native!.rename(from, to);
  if (result === 0) return true;
  const errno = native!.errno(); // Read immediately, before any further filesystem operation.
  if (errno === 17) return false; // EEXIST on Darwin and Linux: caller revalidates the winner.
  if (errno === 22 || (process.platform === "linux" && (errno === 38 || errno === 95)) || (process.platform === "darwin" && errno === 45)) unavailable();
  throw new MessageError("storage", "Atomic message database publication failed; no overwrite was attempted.");
}
