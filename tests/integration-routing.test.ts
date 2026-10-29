import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../src/install";
import { launchPlan } from "../src/launch";
import { nieuwRecord, schrijfIdentiteit, schrijfRecord } from "../scripts/lead/hooks/register";
import { geenWekker, maakBus } from "../scripts/lead/peers/bus";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-routing-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.each(["flag", "environment"])("installed MCP distinguishes a %s name from workspace identity", async (mode) => {
  const state = join(dir, "state");
  const cwd = join(dir, "project");
  const prefix = join(dir, "prefix");
  const env = { HOME: join(dir, "home"), PATH: process.env.PATH!, RELAY_STATE_DIR: state };
  mkdirSync(cwd);
  mkdirSync(env.HOME);
  install(["--prefix", prefix], env);
  const now = Date.now();
  for (const name of ["sender", "claude-peer", "codex-peer"]) {
    schrijfRecord(state, { ...nieuwRecord(name, { LAB_AGENT_NAAM: name }, cwd, now), host: "geen", inbound: { standaard: "accept" } });
  }
  schrijfIdentiteit(state, cwd, { naam: "codex-peer", rol: "agent", lead: "", opdracht: "", spawn_id: "legacy-fixture", ts: now });
  const bus = maakBus({ staat: state, wekker: geenWekker });
  expect((await bus.send("sender", "claude-peer", "requested inbox")).ok).toBe(true);
  expect((await bus.send("sender", "codex-peer", "leave this unread")).ok).toBe(true);
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: {} } });
  const child = Bun.spawnSync([join(prefix, "bin/relay"), ...(mode === "flag" ? ["--name", "claude-peer"] : []), "mcp"], {
    cwd,
    env: { ...env, ...(mode === "environment" ? { RELAY_NAME: "claude-peer" } : {}) },
    stdin: Buffer.from(`${request}\n`), stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect(child.exitCode).toBe(0);
  const response = JSON.parse(child.stdout.toString());
  expect(response.result.content[0].text).toContain(mode === "flag" ? "requested inbox" : "leave this unread");
  expect(bus.inbox("claude-peer")).toHaveLength(mode === "flag" ? 0 : 1);
  expect(bus.inbox("codex-peer")).toHaveLength(mode === "flag" ? 1 : 0);
});

test("launcher MCP uses safe startup and keeps fixed Claude versus live Codex identity separate", () => {
  const cwd = join(dir, "project");
  const state = join(dir, "state");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./attack.ts"]\n');
  writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "*": ["./attack.ts"] } } }));
  writeFileSync(join(cwd, "attack.ts"), 'console.log("UNTRUSTED STARTUP");\n');
  const env = { HOME: join(dir, "home"), PATH: process.env.PATH!, RELAY_STATE_DIR: state, RELAY_MCP_NAME: "old-inherited-peer" };
  const claude = launchPlan("claude", ["--name", "claude-peer", "--cwd", cwd], env);
  const config = JSON.parse(claude.argv[claude.argv.indexOf("--mcp-config") + 1]!).mcpServers.peers;
  schrijfRecord(state, { ...nieuwRecord("claude-peer", { LAB_AGENT_NAAM: "claude-peer" }, cwd, Date.now()), host: "geen" });
  expect(config.env.RELAY_MCP_NAME).toBe("claude-peer");
  expect(claude.env.RELAY_MCP_NAME).toBeUndefined();
  expect(claude.env.LAB_AGENT_ROL).toBe("agent");
  const child = Bun.spawnSync([config.command, ...config.args], { cwd, env: { ...env, RELAY_STATE_DIR: join(dir, "old-daemon-state"), ...config.env }, stdin: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list","arguments":{}}}\n'), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).not.toContain("UNTRUSTED STARTUP");
  const responses = child.stdout.toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(responses[0].result.tools.map((tool: { name: string }) => tool.name)).toContain("inbox");
  expect(responses[1].result.content[0].text).toContain("claude-peer");
  const codex = launchPlan("codex", ["--name", "codex-peer", "--cwd", cwd], env);
  const setting = codex.argv.find((arg) => arg.startsWith("mcp_servers.peers.env="))!;
  const codexEnv = (Bun.TOML.parse(setting) as any).mcp_servers.peers.env;
  expect(codexEnv.RELAY_MCP_NAME).toBe("");
  expect(codexEnv.RELAY_NAME).toBe("");
  expect(codexEnv.RELAY_STATE_DIR).toBe(state);
  expect(codexEnv.LAB_AGENT_NAAM).toBe("");
  expect(codex.env.RELAY_MCP_NAME).toBeUndefined();
});

test("an inherited environment name cannot become an inbox fallback after a workspace owner dies", async () => {
  const cwd = join(dir, "project");
  const state = join(dir, "state");
  const prefix = join(dir, "prefix");
  const env = { HOME: join(dir, "home"), PATH: process.env.PATH!, RELAY_STATE_DIR: state, RELAY_NAME: "shell-peer" };
  mkdirSync(cwd);
  mkdirSync(env.HOME);
  install(["--prefix", prefix], env);
  for (const name of ["sender", "shell-peer", "codex-peer"]) schrijfRecord(state, { ...nieuwRecord(name, { LAB_AGENT_NAAM: name }, cwd, Date.now()), host: "geen", inbound: { standaard: "accept" } });
  schrijfIdentiteit(state, cwd, { naam: "codex-peer", rol: "agent", lead: "", opdracht: "", spawn_id: "dead-fixture", ts: Date.now(), relay_owner: { pid: process.pid, start: "different OS birth time" } });
  const bus = maakBus({ staat: state, wekker: geenWekker });
  expect((await bus.send("sender", "shell-peer", "keep the shell owner's message")).ok).toBe(true);
  const child = Bun.spawnSync([join(prefix, "bin/relay"), "mcp"], { cwd, env, stdin: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox","arguments":{}}}\n'), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).result.isError).toBe(true);
  expect(bus.inbox("shell-peer")).toHaveLength(1);
});
