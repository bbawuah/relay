import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { install, messageRuntimeFiles, MESSAGE_RUNTIME_DIRECTORIES, MESSAGE_RUNTIME_FILES } from "../src/install";

const ROOT = resolve(import.meta.dir, "..");
const BASELINE = "567767912dd6d9845d20f279e25f0f51e6cece40";
const temporary: string[] = [];
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-package-")));
  temporary.push(dir);
  return dir;
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function put(root: string, file: string, content: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}
/** Boundary mutations use an inert module graph, never stand in for CLI smoke. */
function boundaryFixture() {
  const root = scratch();
  for (const file of MESSAGE_RUNTIME_FILES) put(root, file, file === "package.json" ? '{"version":"0.2.0","private":true}' : "export {};\n");
  for (const dir of MESSAGE_RUNTIME_DIRECTORIES) put(root, `${dir}/index.ts`, "export {};\n");
  return root;
}
function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(join(root, entry.name)).map((name) => `${entry.name}/${name}`) : [entry.name]);
}

test("actual runtime has a closed message-only import graph and no retired product trees", () => {
  const files = messageRuntimeFiles(ROOT);
  expect(files).toContain("src/cli.ts");
  expect(files).toContain("src/mcp/server.ts");
  for (const path of ["scripts/lead", "agents", "src/launch.ts", "src/identity.ts", "src/session-child.ts", "relay.toml"]) expect(existsSync(join(ROOT, path))).toBe(false);
  expect(files.some((file) => file.startsWith("scripts/") || file.startsWith("agents/") || file.endsWith(".test.ts"))).toBe(false);
});

test("installed copy contains exactly validated runtime files and explicit docs; no development or vendor baggage", () => {
  const root = scratch();
  const home = join(root, "home"), prefix = join(root, "prefix");
  mkdirSync(home);
  install(["--prefix", prefix], { HOME: home, PATH: process.env.PATH });
  const target = join(prefix, "lib/relay");
  const files = walk(target);
  const code = files.filter((file) => file.endsWith(".ts") || file === "package.json").sort();
  expect(code).toEqual(messageRuntimeFiles(ROOT));
  for (const path of ["scripts", "agents", "node_modules", ".git", "relay.toml", "src/launch.ts"]) expect(existsSync(join(target, path))).toBe(false);
  const marker = JSON.parse(readFileSync(join(target, ".relay-install.json"), "utf8"));
  expect(marker.version).toBe("0.2.0");
  expect(marker.runtimeFiles).toEqual(code);
  expect(marker.prefix).toBe(prefix);
  expect(readFileSync(join(prefix, "bin/relay"), "utf8")).toContain(marker.installationId);
  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(existsSync(join(home, ".codex"))).toBe(false);
  expect(existsSync(join(home, ".local/state"))).toBe(false);
});

for (const path of ["../scripts/lead/peers/bus", "./launch", "./identity", "./session-child", "third-party"]) {
  test(`package refuses active retired, missing or external import ${path}`, () => {
    const root = boundaryFixture();
    put(root, "src/cli.ts", `import ${JSON.stringify(path)};\n`);
    expect(() => messageRuntimeFiles(root)).toThrow(/retired or missing|external dependency/);
  });
}

test("package validates literal dynamic imports too", () => {
  const root = boundaryFixture();
  put(root, "src/cli.ts", 'await import("./launch");\n');
  expect(() => messageRuntimeFiles(root)).toThrow("retired or missing");
});

test("polyglot entry shebang does not exempt its active imports from validation", () => {
  const root = boundaryFixture();
  cpSync(join(ROOT, "bin/relay.ts"), join(root, "bin/relay.ts"));
  messageRuntimeFiles(root);
  const code = readFileSync(join(root, "bin/relay.ts"), "utf8");
  put(root, "bin/relay.ts", `${code}\nimport "../src/launch";\n`);
  expect(() => messageRuntimeFiles(root)).toThrow("retired or missing");
});

test("package refuses symlinked source files, directories and ancestors without following them", () => {
  for (const path of ["src/cli.ts", "src/messages", "src"]) {
    const root = boundaryFixture(), external = scratch();
    const target = join(root, path);
    cpSync(target, join(external, "payload"), { recursive: true });
    rmSync(target, { recursive: true });
    symlinkSync(join(external, "payload"), target);
    const before = walk(external);
    expect(() => messageRuntimeFiles(root)).toThrow("symlink");
    expect(walk(external)).toEqual(before);
  }
});

test("missing runtime paths are an actionable owning-stream failure", () => {
  const root = boundaryFixture();
  rmSync(join(root, "src/cli.ts"));
  expect(() => messageRuntimeFiles(root)).toThrow("integrate the owning stream");
});

test("package rejects runtime dependencies and legacy baggage even in an allowed directory", () => {
  const root = boundaryFixture();
  put(root, "package.json", '{"dependencies":{"foreign-runtime":"1"}}');
  expect(() => messageRuntimeFiles(root)).toThrow("third-party runtime dependencies");
  put(root, "package.json", '{"private":true}');
  put(root, "src/messages/spawn.ts", "export {};\n");
  expect(() => messageRuntimeFiles(root)).toThrow("retired product baggage");
});

test("every retired provenance entry preserves source hash/category/former destination and disposition", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "docs/source-manifest.json"), "utf8"));
  const baseline = Bun.spawnSync(["git", "show", `${BASELINE}:docs/source-manifest.json`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(baseline.exitCode).toBe(0);
  const original = JSON.parse(baseline.stdout.toString());
  expect(manifest.sourceRepository).toBe(original.sourceRepository);
  expect(manifest.sourceCommit).toBe(original.sourceCommit);
  expect(manifest.baseRelayCommit).toBe(original.baseRelayCommit);
  expect(manifest.files).toHaveLength(original.files.length);
  const retired = manifest.files.filter((entry: any) => entry.disposition === "retired");
  expect(retired.length).toBeGreaterThan(100);
  for (const entry of retired) {
    const before = original.files.find((file: any) => file.source === entry.source);
    expect(before).toBeTruthy();
    expect(entry.sourceSha256).toBe(before.sourceSha256);
    expect(entry.category).toBe(before.category);
    expect(entry.formerDestination).toBe(before.destination);
    expect(entry.extractionUnchanged).toBe(before.unchanged);
    expect(entry.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.source).toBeTruthy(); expect(entry.category).toBeTruthy();
    expect(entry.formerDestination).toBeTruthy(); expect(entry.destination).toBeNull();
    expect(entry.unchanged).toBe(false); expect(entry.retiredInVersion).toBe("0.2.0");
    expect(entry.reason).toBeTruthy(); expect(existsSync(join(ROOT, entry.formerDestination))).toBe(false);
  }
  for (const entry of manifest.files.filter((entry: any) => entry.destination)) expect(existsSync(join(ROOT, entry.destination))).toBe(true);
});

test("every removed test from the committed baseline has a per-file retirement reason", () => {
  const result = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", BASELINE], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const ledger = readFileSync(join(ROOT, "docs/test-retirement.md"), "utf8");
  const removed = result.stdout.toString().split("\n").filter((file) => /(?:\.test\.ts|test_sessie_samenvatting\.py|hook-canaries\.sh)$/.test(file) && !existsSync(join(ROOT, file)));
  expect(removed.length).toBeGreaterThan(30);
  for (const file of removed) expect(ledger).toContain(`| \`${file}\` |`);
});
