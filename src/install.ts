import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { shellQuote, type Environment } from "./environment";
import { bunArgs } from "./runtime";

const ROOT = resolve(import.meta.dir, "..");
const MARKER = ".relay-install.json";
const SIGNATURE = "# Relay managed launcher";

/** The complete allowed runtime surface. Never copy scripts, skills or hooks. */
export const MESSAGE_RUNTIME_FILES = [
  "bin/relay.ts", "src/cli.ts", "src/environment.ts", "src/install.ts", "src/runtime.ts", "package.json",
] as const;
export const MESSAGE_RUNTIME_DIRECTORIES = [
  "src/messages", "src/directory", "src/storage", "src/dispatch", "src/adapters", "src/migration",
] as const;
const OPTIONAL_RUNTIME_DIRECTORIES = ["src/app", "src/mcp"] as const;
const DOCUMENTATION = [
  "README.md", "docs/configuration.md", "docs/source-manifest.json", "docs/test-retirement.md",
  "docs/t3-message-poc.md", "docs/message-migration.md",
] as const;

/** Scan code without executing it, and prove every import ships in the copy. */
export function messageRuntimeFiles(source = ROOT): string[] {
  const files: string[] = [];
  const add = (entry: string) => {
    const path = join(source, entry);
    if (!isPresent(path)) throw new Error(`message runtime is incomplete: missing ${entry}; integrate the owning stream before installing`);
    const parts = entry.split("/");
    for (let length = 1; length <= parts.length; length++) {
      if (lstatSync(join(source, ...parts.slice(0, length))).isSymbolicLink()) throw new Error(`refusing a symlink in the message runtime: ${entry}`);
    }
    const stat = lstatSync(path);
    if (/(?:^|\/)(?:lead|hooks?|skills?|policy|beleid|launch|identity|session-child|spawn|git(?:-hard)?|merge|push|wachtrij|queue)(?:[/.\-]|$)/i.test(entry)) {
      throw new Error(`retired product baggage in the message runtime: ${entry}`);
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(`${entry}/${name}`);
    } else if (stat.isFile() && !entry.endsWith(".test.ts")) {
      if (!entry.endsWith(".ts") && entry !== "package.json") throw new Error(`unexpected message runtime file: ${entry}`);
      files.push(entry);
    } else if (!stat.isFile()) throw new Error(`unexpected message runtime entry: ${entry}`);
  };
  for (const entry of MESSAGE_RUNTIME_FILES) add(entry);
  for (const entry of MESSAGE_RUNTIME_DIRECTORIES) add(entry);
  for (const entry of OPTIONAL_RUNTIME_DIRECTORIES) if (isPresent(join(source, entry))) add(entry);
  const shipped = new Set(files.map((entry) => resolve(source, entry)));
  const scanner = new Bun.Transpiler({ loader: "ts" });
  for (const entry of files.filter((file) => file.endsWith(".ts"))) {
    // scanImports does not accept the executable polyglot entry's shebang.
    const code = readFileSync(join(source, entry), "utf8").replace(/^#![^\n]*\n/, "");
    for (const dependency of scanner.scanImports(code)) {
      const name = dependency.path;
      if (name.startsWith("node:") || name.startsWith("bun:")) continue;
      if (!name.startsWith(".")) throw new Error(`message runtime has an external dependency: ${entry} -> ${name}`);
      const path = resolve(source, dirname(entry), name);
      if (![path, `${path}.ts`, join(path, "index.ts")].some((candidate) => shipped.has(candidate))) {
        throw new Error(`message runtime imports a retired or missing path: ${entry} -> ${name}; integrate the owning stream before installing`);
      }
    }
  }
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (Object.keys(pkg.dependencies ?? {}).length) throw new Error("message runtime must not have third-party runtime dependencies");
  return files.sort();
}

function options(args: string[], env: Environment, defaultPrefix = join(env.HOME || homedir(), ".local")) {
  let prefix = defaultPrefix;
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

/** Resolve existing ancestors before creating anything, including a missing prefix. */
function canonicalDestination(path: string): string {
  const missing: string[] = [];
  let ancestor = path;
  while (!isPresent(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

function outsideSource(prefix: string, target: string, launcher: string, uninstallSelf = false): string {
  const source = realpathSync(ROOT);
  for (const path of [prefix, target, launcher]) {
    const destination = canonicalDestination(path);
    if (uninstallSelf && path === target && destination === source) continue;
    if (source === destination || destination.startsWith(`${source}/`) || (path !== prefix && source.startsWith(`${destination}/`))) {
      throw new Error("installation prefix must be outside the source checkout");
    }
  }
  return source;
}

function ownPrefix(): string {
  const failure = () => new Error(`cannot verify the original installation prefix for ${ROOT}; use relay uninstall --prefix DIR to choose a managed installation explicitly`);
  const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value;
  try {
    const marker = join(ROOT, MARKER);
    if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) throw failure();
    const origin = JSON.parse(readFileSync(marker, "utf8"));
    if (!origin || origin.application !== "relay" || !absolute(origin.prefix) || !absolute(origin.target) || !absolute(origin.launcher)
      || typeof origin.installationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(origin.installationId)) throw failure();
    // A changed alias must never select another runtime or launcher. Bind the
    // command as well, so replacing it with another managed command fails safe.
    const target = realpathSync(join(origin.prefix, "lib", "relay"));
    const launcher = join(origin.prefix, "bin", "relay");
    if (target !== realpathSync(ROOT) || target !== origin.target || canonicalDestination(launcher) !== origin.launcher
      || lstatSync(launcher).isSymbolicLink() || !lstatSync(launcher).isFile()
      || !readFileSync(launcher, "utf8").includes(`\n# Relay installation: ${origin.installationId}\n`)) throw failure();
    return origin.prefix;
  } catch {
    // Includes missing/legacy markers and broken routes: never guess a default.
    throw failure();
  }
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
  const source = outsideSource(prefix, target, launcher);
  owned(target, launcher);
  const runtimeFiles = messageRuntimeFiles(source);
  if (dryRun) return `Would install Relay into ${target}\nWould write ${launcher}\nNo hooks, shell profiles or state would be changed.`;
  const origin = { prefix, target: canonicalDestination(target), launcher: canonicalDestination(launcher), installationId: crypto.randomUUID() };
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), ".relay-stage-"));
  let backup: string | undefined;
  try {
    // Copy only validated message code and explicitly named documentation.
    for (const entry of [...runtimeFiles, ...DOCUMENTATION.filter((entry) => isPresent(join(source, entry)))]) {
      const path = join(source, entry);
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`refusing non-file package input: ${entry}`);
      mkdirSync(dirname(join(stage, entry)), { recursive: true });
      cpSync(path, join(stage, entry));
    }
    writeFileSync(join(stage, MARKER), `${JSON.stringify({ application: "relay", version: JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version, runtimeFiles, ...origin })}\n`, { mode: 0o600 });
    if (existsSync(target)) {
      backup = `${stage}.previous`;
      renameSync(target, backup);
    }
    renameSync(stage, target);
    const temporaryLauncher = join(dirname(launcher), `.relay-${crypto.randomUUID()}.tmp`);
    try {
      // Keep the PATH symlink (e.g. Homebrew bin/bun), rather than its versioned
      // realpath. If that executable disappears, discover the replacement at use.
      const stableBun = Bun.which("bun", { PATH: env.PATH ?? process.env.PATH ?? "" });
      const bun = stableBun && isAbsolute(stableBun) ? stableBun : process.execPath;
      // Start the recorded runtime even if prefix/lib is later redirected; its
      // origin check can then refuse instead of running another installation.
      const argv = bunArgs(join(origin.target, "bin", "relay.ts")).map(shellQuote).join(" ");
      writeFileSync(temporaryLauncher, `#!/bin/sh\n${SIGNATURE}\n# Relay installation: ${origin.installationId}\nunset BUN_OPTIONS NODE_OPTIONS\nBUN=${shellQuote(bun)}\nif [ ! -x "$BUN" ]; then BUN=$(command -v bun 2>/dev/null); fi\nif [ -z "$BUN" ] || [ ! -x "$BUN" ]; then echo 'Relay needs Bun >= 1.4.2 on PATH.' >&2; exit 127; fi\nexec "$BUN" ${argv} "$@"\n`, { mode: 0o755 });
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
  const { prefix, dryRun, target, launcher } = options(args, env, args.includes("--prefix") ? undefined : ownPrefix());
  outsideSource(prefix, target, launcher, true);
  owned(target, launcher);
  if (dryRun) return `Would remove the managed installation at ${target} and ${launcher}. State and hook settings remain.`;
  rmSync(launcher, { force: true });
  rmSync(target, { force: true, recursive: true });
  return "Relay uninstalled. State and vendor hook settings were preserved.";
}
