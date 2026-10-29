import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environment } from "../src/environment";
import { launchPlan } from "../src/launch";
import { install, uninstall } from "../src/install";
import { alleRecords } from "../scripts/lead/hooks/register";

let dir: string;
let state: string;
let prefix: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-install-"));
  state = join(dir, "state");
  prefix = join(dir, "prefix with 'quotes'");
  env = { PATH: process.env.PATH || "", HOME: join(dir, "home"), RELAY_STATE_DIR: state };
  mkdirSync(env.HOME!, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[], input = "", cwd = dir) {
  const result = Bun.spawnSync([join(prefix, "bin/relay"), ...args], { env, cwd, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("a copied installation sends, receives and acknowledges through CLI and MCP", () => {
  install(["--prefix", prefix], env);
  expect(cli(["--version"]).code).toBe(0);
  const lead = cli(["register", "--name", "lead"]);
  const worker = cli(["register", "--name", "worker", "--lead", "lead"]);
  expect(lead.code).toBe(0);
  expect(worker.code).toBe(0);
  const sent = cli(["--name", "worker", "send", "lead", "ready, with $(literal text)"]);
  expect(sent.code).toBe(0);
  expect(sent.out).toContain("afgeleverd");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "inbox", arguments: {} } },
  ];
  const received = cli(["--name", "lead", "mcp"], `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  expect(received.code).toBe(0);
  const replies = received.out.trim().split("\n").map((line) => JSON.parse(line));
  expect(replies[1].result.content[0].text).toContain("ready, with $(literal text)");
  expect(replies[1].result.content[0].text).toContain("<<<begin");
  expect(cli(["--name", "lead", "inbox"]).out).toContain("Geen berichten");
  expect(cli(["unregister", worker.out.trim()]).code).toBe(0);
  expect(alleRecords(state).find((r) => r.naam === "worker")?.toestand).toBe("weg");
});

test("unrelated sessions are held and only an operator can release them", () => {
  install(["--prefix", prefix], env);
  expect(cli(["register", "--name", "one"]).code).toBe(0);
  expect(cli(["register", "--name", "two"]).code).toBe(0);
  expect(cli(["--name", "one", "send", "two", "held"]).out).toContain("vastgehouden");
  expect(cli(["--role", "agent", "release", "two"]).code).toBe(1);
  expect(cli(["hold", "two"]).out).toContain("held");
  expect(cli(["release", "two"]).code).toBe(0);
  expect(cli(["--name", "two", "inbox"]).out).toContain("held");
  expect(cli(["register", "--name", "ONE"]).code).toBe(1);
  expect(cli(["register", "--name", "../escape"]).code).toBe(1);
});

test("install is repeatable, dry-run writes nothing and uninstall preserves state", () => {
  install(["--prefix", prefix, "--dry-run"], env);
  expect(existsSync(prefix)).toBe(false);
  install(["--prefix", prefix], env);
  expect(cli(["register", "--name", "saved"]).code).toBe(0);
  const records = alleRecords(state);
  install(["--prefix", prefix], env);
  expect(cli(["doctor"]).code).toBe(0);
  uninstall(["--prefix", prefix], env);
  expect(existsSync(join(prefix, "bin/relay"))).toBe(false);
  expect(alleRecords(state)).toEqual(records);
});

test("install refuses to overwrite another executable or an unmarked runtime", () => {
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin/relay"), "someone else's program");
  expect(() => install(["--prefix", prefix], env)).toThrow("unmanaged command");
  expect(readFileSync(join(prefix, "bin/relay"), "utf8")).toBe("someone else's program");
  rmSync(join(prefix, "bin/relay"));
  mkdirSync(join(prefix, "lib/relay"), { recursive: true });
  expect(() => install(["--prefix", prefix], env)).toThrow("unmanaged directory");
});

test("Relay aliases override legacy identity without passing preloads to children", () => {
  const e = environment({ ...env, RELAY_NAME: "relay-name", LAB_AGENT_NAAM: "legacy", BUN_OPTIONS: "unsafe", NODE_OPTIONS: "unsafe" });
  expect(e.LAB_AGENT_NAAM).toBe("relay-name");
  expect(e.LAB_LEAD_STAAT).toBe(state);
  expect(e.BUN_OPTIONS).toBeUndefined();
  expect(e.NODE_OPTIONS).toBeUndefined();
});

test("launch adds per-session hooks and MCP without changing global settings or approval flags", () => {
  const plan = launchPlan("claude", ["--name", "lead", "--cwd", dir, "--", "a prompt with 'quotes'"], { ...env, RELAY_NAME: "old-parent" });
  expect(plan.env.LAB_AGENT_NAAM).toBe("lead");
  expect(plan.env.RELAY_NAME).toBeUndefined();
  expect(plan.env.LAB_AGENT_ROL).toBe("lead");
  const config = JSON.parse(plan.argv[plan.argv.indexOf("--mcp-config") + 1]!);
  expect(config.mcpServers.peers.env.LAB_LEAD_STAAT).toBe(state);
  const settings = JSON.parse(plan.argv[plan.argv.indexOf("--settings") + 1]!);
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(plan.argv.at(-1)).toBe("a prompt with 'quotes'");
  expect(plan.argv.some((arg) => /skip-permissions|bypass|allowedTools/.test(arg))).toBe(false);
  const codex = launchPlan("codex", ["--name", "worker", "--lead", "lead", "--cwd", dir], env);
  expect(codex.env.LAB_AGENT_ROL).toBe("agent");
  expect(codex.argv).toContain("mcp_servers.peers.command=" + JSON.stringify(process.execPath));
  expect(existsSync(join(env.HOME!, ".codex"))).toBe(false);
  expect(() => launchPlan("codex", ["--name", "x", "--", "-C", "/another/checkout"], env)).toThrow("identity");
});

test("installed Claude launcher actually registers hooks and provides working MCP to the child", () => {
  install(["--prefix", prefix], env);
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  const fake = join(bin, "claude");
  writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2);
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const peers = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.peers;
for (const event of ["SessionStart", "SessionEnd"]) {
  const command = settings.hooks[event][0].hooks[0].command;
  const hook = Bun.spawnSync(["sh", "-c", command], { env: process.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: event, session_id: "fake-claude", cwd: process.cwd() })), stdout: "pipe", stderr: "pipe" });
  if (hook.exitCode) throw new Error(hook.stderr.toString());
  if (event === "SessionStart") {
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list", arguments: {} } };
    const mcp = Bun.spawnSync([peers.command, ...peers.args], { env: { ...process.env, ...peers.env }, stdin: Buffer.from(JSON.stringify(request) + "\\n"), stdout: "pipe", stderr: "pipe" });
    if (mcp.exitCode) throw new Error(mcp.stderr.toString());
    console.log(mcp.stdout.toString());
    if (process.env.RELAY_TEST_CRASH) process.exit(23);
  }
}
`);
  chmodSync(fake, 0o755);
  env.PATH = `${bin}:${env.PATH}`;
  const result = cli(["claude", "--name", "demo", "--cwd", dir]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("demo");
  expect(alleRecords(state).find((r) => r.id === "fake-claude")?.toestand).toBe("weg");
  expect(existsSync(join(env.HOME!, ".claude/settings.json"))).toBe(false);
  env.RELAY_TEST_CRASH = "1";
  expect(cli(["claude", "--name", "demo", "--cwd", dir]).code).toBe(23);
  expect(alleRecords(state).find((r) => r.id === "fake-claude")?.toestand).toBe("weg");
});

test("installed status uses the caller's project for hardened Git inspection", () => {
  install(["--prefix", prefix], env);
  const project = join(dir, "project");
  const init = Bun.spawnSync(["git", "init", "-q", "-b", "work", project], { env, stdout: "pipe", stderr: "pipe" });
  expect(init.exitCode).toBe(0);
  const commit = Bun.spawnSync(["git", "-C", project, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial"], { env, stdout: "pipe", stderr: "pipe" });
  expect(commit.exitCode).toBe(0);
  expect(cli(["register", "--name", "project-peer"], "", project).code).toBe(0);
  const result = cli(["status", "--json", "--git"], "", project);
  expect(result.code).toBe(0);
  const row = JSON.parse(result.out)[0];
  expect(row.git.schoon).toBe(true);
  expect(row.git.tak).toBe("work");
});

test("installed Codex setup and launcher share state through trusted hooks, and reject a different bus", () => {
  install(["--prefix", prefix], env);
  const bin = join(dir, "fake-bin");
  const home = join(env.HOME!, ".codex");
  mkdirSync(bin);
  mkdirSync(home);
  const fake = join(bin, "codex");
  writeFileSync(fake, `#!${process.execPath}
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const config = Bun.TOML.parse(readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8"));
if (process.argv[2] === "app-server") {
  const hooks = Object.entries(config.hooks).flatMap(([eventName, groups]) => groups.flatMap((group, i) => group.hooks.map((h, j) => ({ key: eventName + i + j, eventName, command: h.command, currentHash: "fake-hash", trustStatus: process.env.RELAY_TEST_TRUST || "trusted" }))));
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id) console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "hooks/list" ? { data: [{ hooks }] } : {} }));
  });
} else {
  for (const event of ["SessionStart", "SessionEnd"]) {
    const command = config.hooks[event][0].hooks[0].command;
    const hook = Bun.spawnSync(["sh", "-c", command], { env: process.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: event, session_id: "fake-codex", cwd: process.cwd() })), stdout: "pipe", stderr: "pipe" });
    if (hook.exitCode) throw new Error(hook.stderr.toString());
  }
}
`);
  chmodSync(fake, 0o755);
  env.PATH = `${bin}:${env.PATH}`;
  const setup = cli(["setup", "codex", "--codex-home", home]);
  expect(setup.code).toBe(0);
  expect(cli(["codex", "--name", "coder", "--lead", "lead", "--cwd", dir]).code).toBe(0);
  const record = alleRecords(state).find((r) => r.id === "fake-codex");
  expect(record?.naam).toBe("coder");
  expect(record?.vendor).toBe("codex");
  expect(record?.toestand).toBe("weg");
  env.RELAY_TEST_TRUST = "modified";
  expect(cli(["codex", "--name", "untrusted", "--cwd", dir]).err).toContain("untrusted");
  expect(alleRecords(state).some((r) => r.naam === "untrusted")).toBe(false);
  delete env.RELAY_TEST_TRUST;
  env.RELAY_STATE_DIR = join(dir, "different-bus");
  const rejected = cli(["codex", "--name", "other", "--cwd", dir]);
  expect(rejected.code).toBe(1);
  expect(rejected.err).toContain("another state directory");
  expect(alleRecords(env.RELAY_STATE_DIR)).toHaveLength(0);
});

test("installed Claude setup preserves other settings and pins Relay state", () => {
  install(["--prefix", prefix], env);
  const settings = join(dir, "settings.json");
  const hooks = join(dir, "lab-lead-hooks");
  const args = ["setup", "claude", "--settings", settings, "--doel", hooks];
  expect(cli([...args, "--dry-run"]).code).toBe(0);
  expect(existsSync(settings)).toBe(false);
  writeFileSync(settings, JSON.stringify({ model: "keep-this", hooks: {} }));
  expect(cli(args).code).toBe(0);
  const config = JSON.parse(readFileSync(settings, "utf8"));
  expect(config.model).toBe("keep-this");
  expect(config.hooks.SessionStart[0].hooks[0].command).toContain(`LAB_LEAD_STAAT=${state}`);
  const original = readFileSync(settings, "utf8");
  expect(cli(args).code).toBe(0);
  expect(readFileSync(settings, "utf8")).toBe(original);
});
