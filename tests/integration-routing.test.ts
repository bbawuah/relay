import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../src/install";
import { nieuwRecord, schrijfIdentiteit, schrijfRecord } from "../scripts/lead/hooks/register";
import { geenWekker, maakBus } from "../scripts/lead/peers/bus";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-routing-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.each(["flag", "environment"])("installed MCP preserves explicit %s identity beside a Codex workspace", async (mode) => {
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
  expect(response.result.content[0].text).toContain("requested inbox");
  expect(response.result.content[0].text).not.toContain("leave this unread");
  expect(bus.inbox("claude-peer")).toHaveLength(0);
  expect(bus.inbox("codex-peer")).toHaveLength(1);
});
