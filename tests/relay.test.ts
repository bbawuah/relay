import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, uninstall } from "../src/install";

let dir: string;
let state: string;
let prefix: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-install-")));
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
function json(args: string[]) {
  const result = cli(args);
  expect(result.err).not.toContain("relay:");
  expect(result.code).toBe(0);
  return JSON.parse(result.out);
}
function mcp(peer: string, requests: object[]) {
  const result = cli(["--peer", peer, "mcp"], requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  expect(result.code).toBe(0);
  return result.out.trim().split("\n").map((line) => JSON.parse(line));
}

test("copied runtime delivers an idempotent message through CLI and peer-bound MCP with explicit ack", () => {
  install(["--prefix", prefix], env);
  expect(cli(["--version"]).out.trim()).toBe("0.2.0");
  const one = json(["register", "--name", "one", "--json"]);
  const two = json(["register", "--name", "two", "--json"]);
  const body = "ready, with $(literal text) and 'quotes'";
  const sent = json(["--peer", one.id, "send", two.id, body, "--request-key", "install-smoke", "--json"]);
  const retry = json(["--peer", one.id, "send", two.id, body, "--request-key", "install-smoke", "--json"]);
  expect(sent.state).toBe("stored");
  expect(retry.id).toBe(sent.id);
  expect(retry.duplicate).toBe(true);
  const replies = mcp(two.id, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "inbox", arguments: {} } },
  ]);
  expect(JSON.stringify(replies.find((reply) => reply.id === 2))).toContain(body);
  expect(json(["--peer", two.id, "inbox", "--json"])).toHaveLength(1);
  expect(json(["--peer", two.id, "inbox", "--json"])).toHaveLength(1);
  const ack = mcp(two.id, [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ack", arguments: { ids: [sent.id] } } }]);
  expect(ack[0].result.isError).not.toBe(true);
  expect(json(["--peer", two.id, "inbox", "--json"])).toEqual([]);
  expect(cli(["unregister", one.id]).code).toBe(0);
  expect(existsSync(join(env.HOME!, ".claude"))).toBe(false);
  expect(existsSync(join(env.HOME!, ".codex"))).toBe(false);
});

test("install is repeatable, dry-run writes nothing and uninstall preserves the message store", () => {
  install(["--prefix", prefix, "--dry-run"], env);
  expect(existsSync(prefix)).toBe(false);
  install(["--prefix", prefix], env);
  json(["register", "--name", "saved", "--json"]);
  const peers = json(["list", "--json"]);
  install(["--prefix", prefix], env);
  expect(json(["list", "--json"])).toEqual(peers);
  expect(cli(["doctor"]).code).toBe(0);
  const database = join(state, "messages.sqlite");
  const before = readFileSync(database);
  uninstall(["--prefix", prefix], env);
  expect(existsSync(join(prefix, "bin/relay"))).toBe(false);
  expect(readFileSync(database)).toEqual(before);
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
