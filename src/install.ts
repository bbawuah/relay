import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shellQuote, type Environment } from "./environment";

const ROOT = resolve(import.meta.dir, "..");
const MARKER = ".relay-install.json";
const SIGNATURE = "# Relay managed launcher";

function options(args: string[], env: Environment) {
  let prefix = join(env.HOME || homedir(), ".local");
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--prefix" && args[i + 1] && !args[i + 1]!.startsWith("--")) prefix = resolve(args[++i]!);
    else throw new Error(`unknown install option: ${args[i]}`);
  }
  prefix = resolve(prefix);
  return { prefix, dryRun, target: join(prefix, "lib", "relay"), launcher: join(prefix, "bin", "relay") };
}

function isPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

function owned(target: string, launcher: string): void {
  if (isPresent(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || !existsSync(join(target, MARKER))) throw new Error(`refusing to replace an unmanaged directory: ${target}`);
    const marker = join(target, MARKER);
    if (lstatSync(marker).isSymbolicLink() || JSON.parse(readFileSync(marker, "utf8")).application !== "relay") throw new Error(`invalid installation marker: ${target}`);
  }
  if (isPresent(launcher) && (lstatSync(launcher).isSymbolicLink() || !lstatSync(launcher).isFile() || !readFileSync(launcher, "utf8").includes(SIGNATURE))) throw new Error(`refusing to replace an unmanaged command: ${launcher}`);
}

export function install(args: string[], env: Environment = process.env): string {
  const { prefix, dryRun, target, launcher } = options(args, env);
  owned(target, launcher);
  const source = realpathSync(ROOT);
  const destination = existsSync(target) ? realpathSync(target) : target;
  if (source === destination || destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) throw new Error("installation prefix must be outside the source checkout");
  if (dryRun) return `Would install Relay into ${target}\nWould write ${launcher}\nNo hooks, shell profiles or state would be changed.`;
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), ".relay-stage-"));
  let backup: string | undefined;
  try {
    // A complete runtime, without development dependencies, history, or transcripts.
    for (const entry of ["bin", "src", "scripts", "agents", "README.md", "docs", "package.json", "relay.toml"]) {
      cpSync(join(source, entry), join(stage, entry), { recursive: true, filter: (path) => !path.endsWith(".test.ts") && !path.includes("/node_modules/") });
    }
    writeFileSync(join(stage, MARKER), `${JSON.stringify({ application: "relay", version: JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version })}\n`, { mode: 0o600 });
    if (existsSync(target)) {
      backup = `${stage}.previous`;
      renameSync(target, backup);
    }
    renameSync(stage, target);
    const temporaryLauncher = join(dirname(launcher), `.relay-${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryLauncher, `#!/bin/sh\n${SIGNATURE}\nunset BUN_OPTIONS NODE_OPTIONS\nexec ${shellQuote(process.execPath)} ${shellQuote(join(target, "bin", "relay.ts"))} "$@"\n`, { mode: 0o755 });
      chmodSync(temporaryLauncher, 0o755);
      renameSync(temporaryLauncher, launcher);
    } finally { rmSync(temporaryLauncher, { force: true }); }
    if (backup) rmSync(backup, { recursive: true });
  } catch (error) {
    if (backup && existsSync(backup)) {
      rmSync(target, { recursive: true, force: true });
      renameSync(backup, target);
    }
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
  return `Installed Relay: ${launcher}\nRuntime: ${target}\nAdd ${join(prefix, "bin")} to PATH if needed.\nNo global hooks or existing sessions were changed.`;
}

export function uninstall(args: string[], env: Environment = process.env): string {
  const { dryRun, target, launcher } = options(args, env);
  owned(target, launcher);
  if (dryRun) return `Would remove the managed installation at ${target} and ${launcher}. State and hook settings remain.`;
  rmSync(launcher, { force: true });
  rmSync(target, { force: true, recursive: true });
  return "Relay uninstalled. State and vendor hook settings were preserved.";
}
