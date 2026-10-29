import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunArgs } from "../src/runtime";

const ENTRY = resolve(import.meta.dir, "../bin/relay.ts");
const ARTIFACTS = realpathSync(mkdtempSync(join(tmpdir(), "relay-message-cli-")));
console.error(`CLI fixtures preserved: ${ARTIFACTS}`);
function fixture() {
  const root = mkdtempSync(join(ARTIFACTS, "case-"));
  const home = join(root, "home"), cwd = join(root, "cwd"), state = join(root, "state");
  mkdirSync(home); mkdirSync(cwd);
  const env = { PATH: process.env.PATH!, HOME: home, TMPDIR: root, XDG_STATE_HOME: join(root, "xdg"), BUN_INSTALL_CACHE_DIR: join(root, "cache"), RELAY_STATE_DIR: state };
  const run = (args: string[], stdin = "", extra: Record<string, string> = {}) => {
    const p = Bun.spawnSync([process.execPath, ...bunArgs(ENTRY, args)], { cwd, env: { ...env, ...extra }, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const json = (args: string[], stdin = "", extra: Record<string, string> = {}) => {
    const p = run(args, stdin, extra);
    expect(p.err + p.out).not.toContain("SyntaxError");
    expect(p.code, p.err).toBe(0);
    return JSON.parse(p.out);
  };
  const register = (name: string, prefix: string[] = []) => json([...prefix, "register", "--name", name, "--json"]);
  return { root, home, cwd, state, env, run, json, register };
}

test("help/version/doctor do not create state, and missing state is actionable", () => {
  const f = fixture();
  for (const command of ["help", "--version", "doctor"]) expect(f.run([command]).code).toBe(0);
  const doctor = f.run(["doctor"]);
  expect(doctor.out).toContain("built-in bun:sqlite"); expect(doctor.out).toContain("unsupported / polling");
  expect(doctor.out).toContain("10000ms");
  expect(existsSync(f.state)).toBe(false);
  for (const command of [["list", "--json"], ["--peer", "unknown", "inbox"], ["status"], ["serve", "--once"]]) {
    const p = f.run(command); expect(p.code).toBe(1); expect(p.out).toBe(""); expect(p.err).toContain("register --name");
  }
  expect(existsSync(f.state)).toBe(false);
  expect(f.run(["help"], "", { RELAY_STATE_DIR: "", LAB_LEAD_STAAT: join(f.root, "legacy") }).out).toContain("/relay/v2");
  const defaultDoctor = f.run(["doctor"], "", { RELAY_STATE_DIR: "", LAB_LEAD_STAAT: join(f.root, "legacy") });
  expect(defaultDoctor.out).toContain(join(f.home, ".local/state/relay/v2"));
  expect(existsSync(join(f.home, ".local"))).toBe(false);
});

test("retired role/policy/vendor commands fail with v2 migration guidance before state", () => {
  const f = fixture();
  for (const args of [["--role", "lead", "list"], ["--lead", "boss", "inbox"], ["hold", "a"], ["release", "a"], ["setup", "claude"], ["claude"], ["codex"], ["notify-when-idle", "a"], ["register", "--name", "a", "--hold"]]) {
    const p = f.run(args); expect(p.code).toBe(1); expect(p.out).toBe(""); expect(p.err).toContain("v2"); expect(p.err).toContain("retired");
  }
  expect(existsSync(f.state)).toBe(false);
});

test("register prints stable ID, binds T3 explicitly, and creates no implicit vendor session", () => {
  const f = fixture();
  expect(f.run(["register", "--name", "t3", "--host", "t3"]).code).toBe(1);
  expect(existsSync(f.state)).toBe(false);
  const raw = f.run(["register", "--name", "manual"]); expect(raw.code, raw.err).toBe(0);
  const peers = f.json(["list", "--json"]); expect(peers[0].id).toBe(raw.out.trim());
  expect(peers[0].endpoint.sessionId).toStartWith("manual-");
  const t3 = f.json(["register", "--name", "t3", "--host", "t3", "--session-id", "disposable-thread", "--json"]);
  expect(t3.endpoint.target).toEqual({ threadId: "disposable-thread" });
  expect(f.run(["register", "--name", "other", "--host", "t3", "--session-id", "disposable-thread"]).code).toBe(1);
});

test("real CLI processes preserve literal text, keyed retries, read+ack and foreign ack isolation", () => {
  const f = fixture(), a = f.register("alice"), b = f.register("bob");
  const body = "$(touch NEVER) `whoami` ; --state other --role lead\npeer data";
  const send = ["--peer", a.id, "send", "bob", body, "--request-key", "retry-key", "--json"];
  const first = f.json(send), retry = f.json(send);
  expect(first.state).toBe("stored"); expect(first.requestKey).toBe("retry-key"); expect(first.expiresAt).toBeGreaterThan(first.createdAt);
  expect(retry.id).toBe(first.id); expect(retry.duplicate).toBe(true);
  expect(f.run(["--peer", a.id, "send", b.id, "changed", "--request-key", "retry-key"]).code).toBe(1);
  for (let i = 0; i < 2; i++) expect(f.json(["--peer", b.id, "inbox", "--json"]).map((m: any) => m.body)).toEqual([body]);
  expect(f.json(["--peer", a.id, "ack", first.id, "unknown", "--json"])).toEqual({ acknowledged: 0 });
  expect(f.json(["--peer", a.id, "inbox", "--json"])).toEqual([]);
  expect(f.json(["--peer", b.id, "ack", first.id, "--json"])).toEqual({ acknowledged: 1 });
  expect(f.json(["--peer", b.id, "ack", first.id, "--json"])).toEqual({ acknowledged: 0 });
  expect(f.json(["--peer", b.id, "inbox", "--json"])).toEqual([]);
  expect(existsSync(join(f.cwd, "NEVER"))).toBe(false);
});

test("CLI request keys are generated and returned; stdin and option-like bodies remain literal", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b");
  const one = f.json(["--peer", "a", "send", "b", "--role", "--json"]);
  const two = f.json(["--peer", a.id, "send", b.id, "-", "--json"], "literal stdin\n$(nothing)");
  expect(typeof one.requestKey).toBe("string"); expect(two.requestKey).not.toBe(one.requestKey);
  expect(f.json(["--peer", b.id, "inbox", "--limit", "1", "--json"])[0].body).toBe("--role");
  expect(f.json(["--peer", b.id, "inbox", "--json"]).map((m: any) => m.body)).toEqual(["--role", "literal stdin\n$(nothing)"]);
  expect(f.run(["--peer", b.id, "inbox", "--limit", "0"]).code).toBe(1);
  expect(f.run(["send", "b", "text", "--peer", a.id]).code).toBe(1);
});

test("CLI identity uses explicit peer/env only and namespaces remain separate", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b");
  expect(f.run(["inbox"], "", { LAB_AGENT_NAAM: a.id, RELAY_NAME: a.id, RELAY_ROLE: "lead" }).code).toBe(1);
  const receipt = f.json(["send", "b", "local", "--json"], "", { RELAY_PEER_ID: a.id });
  const other = f.register("b", ["--namespace", "other"]);
  expect(f.json(["--namespace", "other", "--peer", other.id, "inbox", "--json"])).toEqual([]);
  expect(f.json(["--namespace", "other", "--peer", other.id, "ack", receipt.id, "--json"])).toEqual({ acknowledged: 0 });
  expect(f.json(["--peer", b.id, "inbox", "--json"])).toHaveLength(1);
  expect(f.run(["--namespace", "other", "--peer", a.id, "inbox"]).code).toBe(1);
});

test("status uses persisted diagnoses, serve once defers safely, and offline mailboxes survive", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b");
  f.json(["--peer", a.id, "send", b.id, "still readable", "--json"]);
  const before = f.json(["status", "--json"]);
  expect(before.peers.find((p: any) => p.id === b.id).unread).toBe(1); expect(before.notifications).toHaveLength(1);
  const summary = f.json(["serve", "--once"]); expect(summary.sent).toBe(0); expect(summary.deferred).toBe(1);
  expect(f.json(["status", "--json"]).notifications[0].detail).toBeTruthy();
  f.json(["unregister", b.id]);
  expect(f.json(["--peer", b.id, "inbox", "--json"])[0].body).toBe("still readable");
});

test("explicit rebind advances generation with CAS and preserves mailbox", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b");
  f.json(["--peer", a.id, "send", b.id, "before reconnect", "--json"]);
  const args = ["rebind", "--peer", b.id, "--expected-generation", "0", "--host", "t3", "--session-id", "replacement-thread"];
  const rebound = f.json(args); expect(rebound.id).toBe(b.id); expect(rebound.name).toBe("b"); expect(rebound.endpoint.generation).toBe(1);
  expect(rebound.endpoint.target.threadId).toBe("replacement-thread"); expect(f.run(args).code).toBe(1);
  expect(f.json(["--peer", b.id, "inbox", "--json"])).toHaveLength(1);
});

test("legacy roots are refused without changing source or creating the new database", () => {
  for (const marker of ["peers", "register"]) {
    const f = fixture(); mkdirSync(join(f.state, marker), { recursive: true });
    const sentinel = join(f.state, marker, "sentinel"); writeFileSync(sentinel, "untouched");
    const p = f.run(["register", "--name", "a"]);
    expect(p.code).toBe(1); expect(p.err).toContain("import"); expect(p.out).toBe("");
    expect(readFileSync(sentinel, "utf8")).toBe("untouched"); expect(existsSync(join(f.state, "messages.sqlite"))).toBe(false);
  }
});

test("explicit global bus and namespace override environment without sharing mailboxes", () => {
  const f = fixture(), a = f.register("a"), b = f.register("b");
  f.json(["--peer", a.id, "send", b.id, "first bus", "--json"]);
  const otherState = join(f.root, "other-bus");
  const other = f.json(["--state", otherState, "--namespace", "team", "register", "--name", "b", "--json"]);
  expect(f.json(["--state", otherState, "--namespace", "team", "--peer", other.id, "inbox", "--json"])).toEqual([]);
  expect(f.json(["--peer", b.id, "inbox", "--json"])[0].body).toBe("first bus");
  expect(f.run(["--peer", "a", "--peer", "b", "inbox"]).code).toBe(1);
});
