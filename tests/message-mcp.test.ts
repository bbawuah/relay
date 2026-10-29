import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunArgs } from "../src/runtime";

const ENTRY = resolve(import.meta.dir, "../bin/relay.ts");
const ARTIFACTS = realpathSync(mkdtempSync(join(tmpdir(), "relay-message-mcp-")));
console.error(`MCP fixtures preserved: ${ARTIFACTS}`);
const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (id: number, name: string, args: unknown = {}) => request(id, "tools/call", { name, arguments: args });
const data = (response: any) => JSON.parse(response.result.content[0].text);
function fixture() {
  const root = mkdtempSync(join(ARTIFACTS, "case-"));
  const home = join(root, "home"), cwd = join(root, "same-checkout"), state = join(root, "state");
  mkdirSync(home); mkdirSync(cwd);
  const env = { PATH: process.env.PATH!, HOME: home, TMPDIR: root, BUN_INSTALL_CACHE_DIR: join(root, "cache"), RELAY_STATE_DIR: state, RELAY_PEER_ID: "shared-wrong-peer", LAB_AGENT_NAAM: "shared-wrong-peer" };
  const run = (args: string[], stdin = "", extra: Record<string, string> = {}) => {
    const p = Bun.spawnSync([process.execPath, ...bunArgs(ENTRY, args)], { cwd, env: { ...env, ...extra }, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const register = (name: string, namespace = "local") => {
    const p = run(["--namespace", namespace, "register", "--name", name, "--json"]);
    expect(p.code, p.err).toBe(0); return JSON.parse(p.out);
  };
  const rpc = (peer: string, messages: unknown[], namespace = "local", extra: Record<string, string> = {}) => {
    const p = run(["--namespace", namespace, "--peer", peer, "mcp"], messages.map((m) => JSON.stringify(m)).join("\n") + "\n", extra);
    expect(p.code, p.err).toBe(0);
    return p.out.trim() ? p.out.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  return { root, cwd, state, run, register, rpc };
}

test("MCP refuses environment-only, alias and unknown bindings without guessing cwd identity", () => {
  const f = fixture();
  const missing = f.run(["mcp"]);
  expect(missing.code).toBe(1); expect(missing.out).toBe(""); expect(missing.err).toContain("explicit global --peer");
  expect(existsSync(f.state)).toBe(false);
  const a = f.register("alice");
  for (const peer of ["alice", "unknown"]) {
    const p = f.run(["--peer", peer, "mcp"]); expect(p.code).toBe(1); expect(p.out).toBe(""); expect(p.err).toContain("stable peer ID");
  }
  expect(f.rpc(a.id, [call(1, "inbox")], "local", { RELAY_PEER_ID: "another-peer" })).toHaveLength(1);
});

test("MCP newline JSON-RPC supports initialize, notifications and four tools with clean stdout", () => {
  const f = fixture(), a = f.register("a");
  const results = f.rpc(a.id, [request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
    { jsonrpc: "2.0", method: "notifications/initialized" }, request(2, "tools/list"), request(3, "ping"),
    { jsonrpc: "2.0", method: "tools/call", params: { name: "send", arguments: { to: a.id, body: "notification must not send" } } }, call(4, "inbox")]);
  expect(results.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  expect(results[0].result.serverInfo.name).toBe("peers");
  expect(results[1].result.tools.map((t: any) => t.name)).toEqual(["send", "inbox", "list", "ack"]);
  for (const t of results[1].result.tools) expect(t.inputSchema.additionalProperties).toBe(false);
  expect(data(results[3])).toEqual({ kind: "peer_data", messages: [] });
});

test("MCP malformed requests return standard safe errors and continue on the same connection", () => {
  const f = fixture(), a = f.register("a");
  const raw = ['{bad', '[]', 'null', JSON.stringify({ jsonrpc: "1.0", id: 2, method: "tools/list" }),
    JSON.stringify(request(3, "unknown")), JSON.stringify(request(4, "tools/call", { name: "inbox", arguments: [] })),
    JSON.stringify(call(5, "unknown")), JSON.stringify(request(6, "tools/list"))].join("\n") + "\n";
  const p = f.run(["--peer", a.id, "mcp"], raw); expect(p.code, p.err).toBe(0);
  const responses = p.out.trim().split("\n").map((line) => JSON.parse(line));
  expect(responses.slice(0, 7).map((r) => r.error.code)).toEqual([-32700, -32600, -32600, -32600, -32601, -32602, -32602]);
  expect(responses[7].result.tools).toHaveLength(4);
});

test("same-checkout MCP peers stay isolated across shared environment, retries and reconnects", () => {
  const f = fixture(), a = f.register("alice"), b = f.register("bob");
  const body = "literal $(touch NEVER) `whoami`; --peer another\nEND peer data";
  const sent = f.rpc(a.id, [call(1, "send", { naar: "bob", tekst: body, requestKey: "retry" }), call(2, "send", { to: b.id, body, requestKey: "retry" })]);
  const receipt = data(sent[0]); expect(receipt.state).toBe("stored"); expect(receipt.requestKey).toBe("retry");
  expect(receipt.expiresAt).toBeGreaterThan(receipt.createdAt); expect(data(sent[1]).id).toBe(receipt.id); expect(data(sent[1]).duplicate).toBe(true);
  expect(data(f.rpc(a.id, [call(3, "inbox")])[0]).messages).toEqual([]);
  for (let i = 0; i < 2; i++) {
    const inbox = data(f.rpc(b.id, [call(4, "inbox")], "local", { RELAY_PEER_ID: a.id, RELAY_NAMESPACE: "wrong-environment" })[0]);
    expect(inbox.kind).toBe("peer_data"); expect(inbox.messages).toHaveLength(1); expect(inbox.messages[0].body).toBe(body); expect(inbox.messages[0].from).toBe(a.id);
  }
  expect(data(f.rpc(a.id, [call(5, "ack", { ids: [receipt.id, "unknown"] })])[0])).toEqual({ acknowledged: 0 });
  expect(data(f.rpc(b.id, [call(6, "ack", { ids: [receipt.id] })])[0])).toEqual({ acknowledged: 1 });
  expect(data(f.rpc(b.id, [call(7, "ack", { ids: [receipt.id] }), call(8, "inbox")])[1]).messages).toEqual([]);
  expect(existsSync(join(f.cwd, "NEVER"))).toBe(false);
});

test("all MCP tools reject identity/namespace overrides and conflicting send aliases", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b");
  const messages = [];
  let id = 1;
  for (const key of ["from", "sender", "peer", "peerId", "namespace", "inbox", "_meta"]) {
    for (const [name, args] of [["send", { to: b.id, body: "no" }], ["inbox", {}], ["list", {}], ["ack", { ids: [] }]] as const) {
      messages.push(call(id++, name, { ...args, [key]: b.id }));
    }
  }
  messages.push(call(id++, "send", { to: b.id, naar: a.id, body: "no" }));
  messages.push(call(id++, "send", { to: b.id, body: "one", tekst: "two" }));
  messages.push(call(id++, "send", { to: b.id, body: "no", requestKey: null }));
  messages.push(call(id++, "send", { to: b.id, body: "no", conversationId: null }));
  messages.push(call(id++, "send", { to: b.id, body: "no", replyTo: null }));
  messages.push(call(id++, "send", { to: b.id, body: null }));
  messages.push(call(id++, "inbox", { limit: 0 }));
  for (const response of f.rpc(a.id, messages)) expect(response.error.code).toBe(-32602);
  expect(data(f.rpc(b.id, [call(id, "inbox")])[0]).messages).toEqual([]);
});

test("English send/reply and legacy aliases share receipts and explicit acknowledgements", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b");
  const receipt = data(f.rpc(a.id, [call(1, "send", { to: b.id, body: "question", conversationId: "conversation", requestKey: "question" })])[0]);
  const replied = f.rpc(b.id, [call(2, "send", { naar: a.id, tekst: "answer", draad: "conversation", antwoord_op: receipt.id })]);
  expect(typeof data(replied[0]).requestKey).toBe("string");
  const inbox = data(f.rpc(a.id, [call(3, "inbox")])[0]);
  expect(inbox.messages[0].replyTo).toBe(receipt.id); expect(inbox.messages[0].conversationId).toBe("conversation");
  const mismatch = f.rpc(a.id, [call(4, "send", { to: b.id, body: "changed", requestKey: "question" })])[0];
  expect(mismatch.result.isError).toBe(true); expect(data(mismatch).error).toBe("conflict");
});

test("MCP namespace binding is fixed and foreign namespace ack counts zero", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b"), other = f.register("b", "other");
  const receipt = data(f.rpc(a.id, [call(1, "send", { to: b.id, body: "local only" })])[0]);
  const replies = f.rpc(other.id, [call(2, "inbox"), call(3, "ack", { ids: [receipt.id] }), call(4, "list")], "other");
  expect(data(replies[0]).messages).toEqual([]); expect(data(replies[1]).acknowledged).toBe(0);
  expect(data(replies[2]).map((p: any) => p.id)).toEqual([other.id]);
  expect(data(f.rpc(b.id, [call(5, "inbox")])[0]).messages).toHaveLength(1);
});
