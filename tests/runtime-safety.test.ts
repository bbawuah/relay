import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { install, uninstall } from "../src/install";
import { bunArgs } from "../src/runtime";
import { environment } from "../src/environment";

const ROOT = resolve(import.meta.dir, "..");
// Intentionally retained: C2 forbids cleanup of manual repro directories.
const scratch = mkdtempSync(join(tmpdir(), "relay-c2-regressions-"));
console.log(`Runtime safety fixtures retained: ${scratch}`);
let sequence = 0;

function fixture() {
  const dir = join(scratch, String(++sequence));
  const cwd = join(dir, "work with 'quotes'");
  const home = join(dir, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home);
  const env = { PATH: process.env.PATH || "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), RELAY_STATE_DIR: join(dir, "state") };
  return { dir, cwd, home, env };
}

function run(argv: string[], f: ReturnType<typeof fixture>, input = "", extra: Record<string, string> = {}) {
  const p = Bun.spawnSync(argv, { cwd: f.cwd, env: { ...f.env, ...extra }, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", timeout: 5000 });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function poison(f: ReturnType<typeof fixture>, kind: "local" | "global" | "dotenv" | "options" | "tsconfig") {
  const marker = join(f.dir, "PRELOAD-RAN");
  const preload = join(f.dir, "preload.ts");
  writeFileSync(preload, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'startup');\n`);
  if (kind === "local") writeFileSync(join(f.cwd, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
  if (kind === "global") {
    mkdirSync(f.env.XDG_CONFIG_HOME, { recursive: true });
    for (const path of [join(f.home, ".bunfig.toml"), join(f.env.XDG_CONFIG_HOME, ".bunfig.toml"), join(f.env.XDG_CONFIG_HOME, "bunfig.toml")]) {
      writeFileSync(path, `preload = [${JSON.stringify(preload)}]\n`);
    }
  }
  if (kind === "dotenv") {
    writeFileSync(join(f.cwd, ".env"), "RELAY_C2_DOTENV=loaded\n");
    writeFileSync(join(f.cwd, ".env.local"), "RELAY_C2_DOTENV=loaded-local\n");
  }
  if (kind === "tsconfig") writeFileSync(join(f.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "*": [preload] } } }));
  return { marker, extra: kind === "options" ? { BUN_OPTIONS: `--preload=${preload}`, NODE_OPTIONS: `--require=${preload}` } : {} };
}

test("real Bun controls demonstrate startup preload, dotenv and tsconfig influence", () => {
  for (const kind of ["local", "dotenv", "tsconfig"] as const) {
    const f = fixture();
    const { marker } = poison(f, kind);
    const main = join(f.dir, "main.ts");
    writeFileSync(main, "console.log(process.env.RELAY_C2_DOTENV || 'clean')\n");
    const result = run([process.execPath, main], f);
    expect(result.code).toBe(0);
    if (kind === "dotenv") expect(result.out).toContain("loaded");
    else expect(existsSync(marker)).toBe(true);
  }
});

for (const entry of ["installed", "package-bin", "install.sh", "hook.sh", "codex-wrap.sh"] as const) {
  for (const kind of ["local", "global", "dotenv", "options", "tsconfig"] as const) {
    test(`${entry} isolates ${kind} before JavaScript starts`, async () => {
      const f = fixture();
      const { marker, extra } = poison(f, kind);
      const probe = "export async function main(args) { console.log(JSON.stringify({ cwd: process.cwd(), dotenv: process.env.RELAY_C2_DOTENV || '', args })); return 0; }\n";
      let argv: string[];
      let expectedArgs: string[];
      if (entry === "installed") {
        const prefix = join(f.dir, "prefix with 'quotes'");
        install(["--prefix", prefix], f.env);
        writeFileSync(join(prefix, "lib/relay/src/cli.ts"), probe);
        argv = [join(prefix, "bin/relay"), "--version"];
        expectedArgs = ["--version"];
      } else if (entry === "package-bin") {
        const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
        const copy = join(f.dir, "package");
        cpSync(join(ROOT, "bin"), join(copy, "bin"), { recursive: true });
        mkdirSync(join(copy, "src"));
        writeFileSync(join(copy, "src/cli.ts"), probe);
        // Model the symlink produced by a package manager; no global install.
        const bin = join(f.dir, "relay");
        symlinkSync(join(copy, pkg.bin.relay), bin);
        argv = [bin, "--version"];
        expectedArgs = ["--version"];
      } else if (entry === "install.sh") {
        const copy = join(f.dir, "checkout");
        cpSync(join(ROOT, "bin"), join(copy, "bin"), { recursive: true });
        cpSync(join(ROOT, "install.sh"), join(copy, "install.sh"));
        mkdirSync(join(copy, "src"));
        writeFileSync(join(copy, "src/cli.ts"), probe);
        argv = [join(copy, "install.sh"), "--prefix", join(f.dir, "install-prefix"), "--dry-run"];
        expectedArgs = ["install", ...argv.slice(1)];
      } else {
        // A standalone installed hook gets only its existing copied files.
        const hooks = join(f.dir, "hooks");
        mkdirSync(hooks);
        cpSync(join(ROOT, "scripts/lead/hooks", entry), join(hooks, entry));
        const main = entry === "hook.sh" ? "hook.ts" : "codex-wrap.ts";
        writeFileSync(join(hooks, main), "console.log(JSON.stringify({ cwd: process.cwd(), dotenv: process.env.RELAY_C2_DOTENV || '', args: process.argv.slice(2) }));\n");
        argv = [join(hooks, entry), "literal argument"];
        expectedArgs = ["literal argument"];
      }
      const result = run(argv, f, "{}", { ...extra, LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: process.execPath });
      expect(result.code).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(result.out)).toEqual({ cwd: realpathSync(f.cwd), dotenv: "", args: expectedArgs });
    });
  }
}

test("CLI helper subprocess uses isolated startup while preserving cwd", () => {
  const f = fixture();
  const { marker } = poison(f, "local");
  writeFileSync(join(f.cwd, ".env"), "RELAY_C2_DOTENV=loaded\n");
  const copy = join(f.dir, "copy");
  for (const entry of ["src", "scripts", "package.json"]) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  writeFileSync(join(copy, "scripts/lead/installeer-hooks.ts"), "console.log(JSON.stringify({ cwd: process.cwd(), dotenv: process.env.RELAY_C2_DOTENV || '' }));\n");
  const driver = join(f.dir, "driver.ts");
  writeFileSync(driver, `import { main } from ${JSON.stringify(join(copy, "src/cli.ts"))}; process.exit(await main(['setup', 'claude']));\n`);
  const result = run([process.execPath, "--config=/dev/null", "--no-env-file", "--no-macros", driver], f);
  expect(result.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.parse(result.out).dotenv).toBe("");
  expect(JSON.parse(result.out).cwd).toBe(realpathSync(f.cwd));
});

for (const mode of ["prefix", "missing descendants", "lib", "bin"]) {
  test(`symlink ${mode} into source is refused before writes`, async () => {
    const f = fixture();
    const source = join(f.dir, "source");
    for (const entry of ["src", "bin", "scripts", "agents", "docs"]) mkdirSync(join(source, entry), { recursive: true });
    for (const name of ["install.ts", "environment.ts", "runtime.ts"]) {
      if (existsSync(join(ROOT, "src", name))) cpSync(join(ROOT, "src", name), join(source, "src", name));
    }
    for (const entry of ["README.md", "package.json", "relay.toml"]) cpSync(join(ROOT, entry), join(source, entry));
    writeFileSync(join(source, "bin/keep"), "unrelated sentinel");
    let prefix = join(f.dir, "prefix-link");
    if (mode === "lib" || mode === "bin") {
      mkdirSync(prefix);
      symlinkSync(source, join(prefix, mode));
    } else {
      symlinkSync(source, prefix);
      if (mode === "missing descendants") prefix = join(prefix, "new/deeper");
    }
    const { install: isolatedInstall, uninstall: isolatedUninstall } = await import(join(source, "src/install.ts"));
    for (const fn of [isolatedInstall, isolatedUninstall]) {
      for (const dryRun of [[], ["--dry-run"]]) {
        expect(() => fn(["--prefix", prefix, ...dryRun], f.env)).toThrow("outside the source checkout");
      }
    }
    expect(readdirSync(source).sort()).toEqual(["README.md", "agents", "bin", "docs", "package.json", "relay.toml", "scripts", "src"]);
    expect(readdirSync(join(source, "bin"))).toEqual(["keep"]);
    expect(readFileSync(join(source, "bin/keep"), "utf8")).toBe("unrelated sentinel");
    if (mode === "lib" || mode === "bin") expect(readdirSync(prefix)).toEqual([mode]);
  });
}

test("bunArgs is safe argv after Bun, with literal arguments and unchanged cwd", async () => {
  const { bunArgs } = await import("../src/runtime");
  const f = fixture();
  const { marker, extra } = poison(f, "local");
  const main = join(f.dir, "main.ts");
  writeFileSync(main, "console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n");
  const args = ["--preload=not-an-option", "literal 'quotes' $(text)"];
  const result = run([process.execPath, ...bunArgs(main, args)], f, "", environment(extra) as Record<string, string>);
  expect(result.code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.parse(result.out).args).toEqual(args);
  expect(JSON.parse(result.out).cwd).toBe(realpathSync(f.cwd));
});

test("bunArgs prevents macro execution before its side effect", async () => {
  const { bunArgs } = await import("../src/runtime");
  for (const safe of [false, true]) {
    const f = fixture();
    const marker = join(f.dir, "MACRO-RAN");
    writeFileSync(join(f.dir, "macro.ts"), `import { writeFileSync } from 'node:fs'; export function value() { writeFileSync(${JSON.stringify(marker)}, 'macro'); return 42; }\n`);
    const main = join(f.dir, "main.ts");
    writeFileSync(main, 'import { value } from "./macro.ts" with { type: "macro" }; console.log(value());\n');
    const result = run([process.execPath, ...(safe ? bunArgs(main) : [main])], f);
    if (safe) {
      expect(existsSync(marker)).toBe(false);
    } else {
      expect(result.code).toBe(0);
      expect(result.out.trim()).toBe("42");
      expect(existsSync(marker)).toBe(true);
    }
  }
});

test("cwd tsconfig cannot redirect trusted relative or builtin imports", async () => {
  const { bunArgs } = await import("../src/runtime");
  const f = fixture();
  const marker = join(f.dir, "TSCONFIG-RAN");
  writeFileSync(join(f.cwd, "hijack.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'tsconfig'); export const trusted = false;\n`);
  writeFileSync(join(f.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "node:*": ["./hijack.ts"], "*": ["./hijack.ts"] }, jsxImportSource: "./hijack.ts" } }));
  writeFileSync(join(f.dir, "trusted.ts"), "export const trusted = true;\n");
  const main = join(f.dir, "main.ts");
  writeFileSync(main, "import { trusted } from './trusted.ts'; import { existsSync } from 'node:fs'; console.log(trusted && typeof existsSync === 'function');\n");
  const result = run([process.execPath, ...bunArgs(main)], f);
  expect(result.code).toBe(0);
  expect(result.out.trim()).toBe("true");
  expect(existsSync(marker)).toBe(false);
});

test("custom prefix uninstall chooses itself and preserves the default installation", () => {
  const f = fixture();
  const other = join(f.home, ".local");
  const custom = join(f.dir, "custom prefix");
  install(["--prefix", other], f.env);
  install(["--prefix", custom], f.env);
  const before = readFileSync(join(other, "bin/relay"), "utf8");
  const dryRun = run([join(custom, "bin/relay"), "uninstall", "--dry-run"], f);
  expect(dryRun.code).toBe(0);
  expect(dryRun.out).toContain(custom);
  expect(existsSync(join(custom, "lib/relay"))).toBe(true);
  const result = run([join(custom, "bin/relay"), "uninstall"], f);
  expect(result.code).toBe(0);
  expect(existsSync(join(custom, "bin/relay"))).toBe(false);
  expect(existsSync(join(custom, "lib/relay"))).toBe(false);
  expect(readFileSync(join(other, "bin/relay"), "utf8")).toBe(before);
  expect(run([join(other, "bin/relay"), "--version"], f).code).toBe(0);
});

test("custom prefix uninstall honors an explicit override", () => {
  const f = fixture();
  const other = join(f.home, ".local");
  const custom = join(f.dir, "custom");
  install(["--prefix", other], f.env);
  install(["--prefix", custom], f.env);
  const result = run([join(custom, "bin/relay"), "uninstall", "--prefix", other], f);
  expect(result.code).toBe(0);
  expect(existsSync(join(other, "bin/relay"))).toBe(false);
  expect(run([join(custom, "bin/relay"), "--version"], f).code).toBe(0);
});

test("hook wrapper preserves blocking exit 2 and stdout under isolated startup", () => {
  const f = fixture();
  const hooks = join(f.dir, "hooks");
  mkdirSync(hooks);
  cpSync(join(ROOT, "scripts/lead/hooks/hook.sh"), join(hooks, "hook.sh"));
  writeFileSync(join(hooks, "hook.ts"), "console.log('HOOK-OUTPUT'); console.error('HOOK-DENIED'); process.exit(2);\n");
  const { marker, extra } = poison(f, "local");
  const result = run([join(hooks, "hook.sh")], f, "{}", { ...extra, LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: process.execPath });
  expect(result.code).toBe(2);
  expect(result.out.trim()).toBe("HOOK-OUTPUT");
  expect(result.err).toContain("HOOK-DENIED");
  expect(existsSync(marker)).toBe(false);
});

for (const stable of [true, false]) {
  test(stable ? "launcher selects stable Bun instead of a version executable" : "launcher falls back when its pinned executable disappears", () => {
    const f = fixture();
    const prefix = join(f.dir, "prefix");
    const fakeBin = join(f.dir, "stable-bin");
    mkdirSync(fakeBin);
    symlinkSync(process.execPath, join(fakeBin, "bun"));
    const version = join(f.dir, "version-bun");
    writeFileSync(version, "#!/bin/sh\nexit 77\n");
    chmodSync(version, 0o755);
    const driver = join(f.dir, "install-driver.ts");
    writeFileSync(driver, `import { install } from ${JSON.stringify(join(ROOT, "src/install.ts"))}; Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(version)} }); install(['--prefix', ${JSON.stringify(prefix)}], { ...process.env, PATH: ${JSON.stringify(stable ? fakeBin : "")} });\n`);
    const installed = run([process.execPath, "--config=/dev/null", "--no-env-file", "--no-macros", driver], f);
    expect(installed.code).toBe(0);
    if (stable) expect(readFileSync(join(prefix, "bin/relay"), "utf8")).toContain(join(fakeBin, "bun"));
    // Simulate a package-manager upgrade without deleting any executable.
    renameSync(version, `${version}.retired`);
    const { marker } = poison(f, "local");
    const result = run([join(prefix, "bin/relay"), "--version"], f, "", { PATH: fakeBin });
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    expect(existsSync(marker)).toBe(false);
  });
}

for (const backingName of ["backing", "storage/lib"]) {
  test(`C4 self-uninstall uses original prefix with symlink-lib to ${backingName}`, () => {
    const f = fixture();
    const other = join(f.home, ".local");
    const prefix = join(f.dir, "custom prefix");
    const backing = join(f.dir, backingName);
    mkdirSync(prefix);
    mkdirSync(backing, { recursive: true });
    symlinkSync(backing, join(prefix, "lib"));
    install(["--prefix", other], f.env);
    install(["--prefix", prefix], f.env);
    const otherLauncher = readFileSync(join(other, "bin/relay"), "utf8");
    const unrelated = join(f.dir, "storage/bin/relay");
    mkdirSync(join(f.dir, "storage/bin"), { recursive: true });
    writeFileSync(unrelated, "#!/bin/sh\n# Relay managed launcher\n# unrelated command\n");
    const result = run([join(prefix, "bin/relay"), "uninstall"], f);
    expect(result.code).toBe(0);
    expect(existsSync(join(prefix, "bin/relay"))).toBe(false);
    expect(existsSync(join(backing, "relay"))).toBe(false);
    expect(readFileSync(join(other, "bin/relay"), "utf8")).toBe(otherLauncher);
    expect(run([join(other, "bin/relay"), "--version"], f).code).toBe(0);
    expect(readFileSync(unrelated, "utf8")).toContain("unrelated command");
  });
}

test("C4 default installation stores its original prefix and self-uninstalls", () => {
  const f = fixture();
  const prefix = join(f.home, ".local");
  install([], f.env);
  const marker = JSON.parse(readFileSync(join(prefix, "lib/relay/.relay-install.json"), "utf8"));
  expect(marker.prefix).toBe(prefix);
  const result = run([join(prefix, "bin/relay"), "uninstall"], f);
  expect(result.code).toBe(0);
  expect(existsSync(join(prefix, "lib/relay"))).toBe(false);
  expect(existsSync(join(prefix, "bin/relay"))).toBe(false);
});

test("C4 changed lib alias refuses without touching either installation", () => {
  const f = fixture();
  const prefix = join(f.dir, "prefix");
  const backing = join(f.dir, "backing");
  const other = join(f.home, ".local");
  mkdirSync(prefix);
  mkdirSync(backing);
  symlinkSync(backing, join(prefix, "lib"));
  install(["--prefix", other], f.env);
  install(["--prefix", prefix], f.env);
  const original = readFileSync(join(prefix, "bin/relay"), "utf8");
  const otherLauncher = readFileSync(join(other, "bin/relay"), "utf8");
  renameSync(join(prefix, "lib"), join(prefix, "lib.retired"));
  symlinkSync(join(other, "lib"), join(prefix, "lib"));
  for (const args of [["--dry-run"], []]) {
    const result = run([join(prefix, "bin/relay"), "uninstall", ...args], f);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("--prefix");
  }
  expect(readFileSync(join(prefix, "bin/relay"), "utf8")).toBe(original);
  expect(readFileSync(join(other, "bin/relay"), "utf8")).toBe(otherLauncher);
  expect(existsSync(join(backing, "relay"))).toBe(true);
  expect(run([join(other, "bin/relay"), "--version"], f).code).toBe(0);
});

test("C4 changed bin alias cannot remove another installation's launcher", () => {
  const f = fixture();
  const prefix = join(f.dir, "prefix");
  const other = join(f.home, ".local");
  install(["--prefix", prefix], f.env);
  install(["--prefix", other], f.env);
  const otherLauncher = readFileSync(join(other, "bin/relay"), "utf8");
  renameSync(join(prefix, "bin"), join(prefix, "original-bin"));
  symlinkSync(join(other, "bin"), join(prefix, "bin"));
  const result = run([join(prefix, "original-bin/relay"), "uninstall"], f);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("--prefix");
  expect(readFileSync(join(other, "bin/relay"), "utf8")).toBe(otherLauncher);
  expect(existsSync(join(prefix, "lib/relay"))).toBe(true);
  expect(existsSync(join(prefix, "original-bin/relay"))).toBe(true);
});

test("C4 changed prefix alias preserves the original runtime and the replacement installation", () => {
  const f = fixture();
  const actual = join(f.dir, "actual-prefix");
  const alias = join(f.dir, "prefix-alias");
  const other = join(f.home, ".local");
  mkdirSync(actual);
  symlinkSync(actual, alias);
  install(["--prefix", alias], f.env);
  install(["--prefix", other], f.env);
  const marker = JSON.parse(readFileSync(join(actual, "lib/relay/.relay-install.json"), "utf8"));
  expect(marker.prefix).toBe(alias);
  const original = readFileSync(join(actual, "bin/relay"), "utf8");
  const otherLauncher = readFileSync(join(other, "bin/relay"), "utf8");
  renameSync(alias, `${alias}.retired`);
  symlinkSync(other, alias);
  const result = run([join(actual, "bin/relay"), "uninstall"], f);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("--prefix");
  expect(readFileSync(join(actual, "bin/relay"), "utf8")).toBe(original);
  expect(readFileSync(join(other, "bin/relay"), "utf8")).toBe(otherLauncher);
  expect(existsSync(join(actual, "lib/relay"))).toBe(true);
  expect(run([join(other, "bin/relay"), "--version"], f).code).toBe(0);
});

test("C4 replacing a launcher with another managed launcher fails safe", () => {
  const f = fixture();
  const prefix = join(f.dir, "prefix");
  const other = join(f.home, ".local");
  install(["--prefix", prefix], f.env);
  install(["--prefix", other], f.env);
  const otherLauncher = readFileSync(join(other, "bin/relay"), "utf8");
  const retained = join(prefix, "bin/original-relay");
  renameSync(join(prefix, "bin/relay"), retained);
  cpSync(join(other, "bin/relay"), join(prefix, "bin/relay"));
  const result = run([retained, "uninstall"], f);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("--prefix");
  expect(readFileSync(join(prefix, "bin/relay"), "utf8")).toBe(otherLauncher);
  expect(readFileSync(join(other, "bin/relay"), "utf8")).toBe(otherLauncher);
  expect(existsSync(join(prefix, "lib/relay"))).toBe(true);
});

test("C4 legacy origin refuses implicit uninstall but accepts explicit managed prefix", () => {
  const f = fixture();
  const prefix = join(f.dir, "prefix");
  const other = join(f.home, ".local");
  install(["--prefix", prefix], f.env);
  install(["--prefix", other], f.env);
  const marker = join(prefix, "lib/relay/.relay-install.json");
  writeFileSync(marker, JSON.stringify({ application: "relay", version: "0.1.0" }));
  const refused = run([join(prefix, "bin/relay"), "uninstall"], f);
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("--prefix");
  expect(existsSync(join(prefix, "lib/relay"))).toBe(true);
  expect(existsSync(join(other, "bin/relay"))).toBe(true);
  const explicit = run([join(prefix, "bin/relay"), "uninstall", "--prefix", prefix], f);
  expect(explicit.code).toBe(0);
  expect(existsSync(join(prefix, "lib/relay"))).toBe(false);
  expect(run([join(other, "bin/relay"), "--version"], f).code).toBe(0);
});

test("C4 changed marker prefix refuses another managed installation", () => {
  const f = fixture();
  const prefix = join(f.dir, "prefix");
  const other = join(f.home, ".local");
  install(["--prefix", prefix], f.env);
  install(["--prefix", other], f.env);
  const marker = join(prefix, "lib/relay/.relay-install.json");
  const data = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(marker, JSON.stringify({ ...data, prefix: other }));
  const result = run([join(prefix, "bin/relay"), "uninstall"], f);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("--prefix");
  expect(existsSync(join(prefix, "lib/relay"))).toBe(true);
  expect(run([join(other, "bin/relay"), "--version"], f).code).toBe(0);
});

test("C4 missing marker does not guess the default installation", () => {
  const f = fixture();
  install([], f.env);
  expect(() => uninstall([], f.env)).toThrow("--prefix");
  expect(run([join(f.home, ".local/bin/relay"), "--version"], f).code).toBe(0);
});
