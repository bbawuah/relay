import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchPlan, verifiedBun } from "../src/launch";
import { alleRecords, heeftIdentiteitsbestand, identiteitPad, IDENTITEIT_MAX_MS, launcherOwner, leesIdentiteit, nieuwRecord, ruimDodeLauncherIdentiteitenOp, schrijfIdentiteit, schrijfRecord, withLaunchLock } from "../scripts/lead/hooks/register";
import { identiteitEnv } from "../scripts/lead/hooks/codex-wrap";
import { maakBlok } from "../scripts/lead/hooks/codex-installeer";
import { metIdentiteit } from "../scripts/lead/peers/server";

let dir: string;
let state: string;
let env: Record<string, string>;
let children: ReturnType<typeof Bun.spawn>[];
let vendorPids: number[];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-launch-safety-")));
  state = join(dir, "state");
  env = { HOME: join(dir, "home"), RELAY_STATE_DIR: state, PATH: "/usr/bin:/bin" };
  mkdirSync(env.HOME!, { recursive: true });
  children = [];
  vendorPids = [];
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(children.map((child) => child.exited));
  for (const pid of vendorPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  rmSync(dir, { recursive: true, force: true });
});

test("both vendors default to agent even with inherited lead privileges or their own lead name", () => {
  for (const vendor of ["claude", "codex"] as const) {
    for (const lead of [[], ["--lead", "worker"]]) {
      const plan = launchPlan(vendor, ["--name", "worker", "--cwd", dir, ...lead], { ...env, LAB_AGENT_ROL: "lead", RELAY_ROLE: "lead" });
      expect(plan.env.LAB_AGENT_ROL).toBe("agent");
      expect(plan.env.RELAY_ROLE).toBeUndefined();
      expect(plan.env.LAB_LEAD_NAAM).toBe(lead.length ? "worker" : "");
    }
  }
});

test("attached configuration, directory, profile and bypass flags cannot replace Relay policy", () => {
  for (const flag of ["-c", "-cfoo=bar", "-c=x", "-p", "-pother", "-p=x", "-C", "-C/other", "-C=/other", "--config", "--config=x", "--profile", "--profile=x", "--cd", "--cd=/other", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--yolo", "--sandbox=danger-full-access", "-sdanger-full-access", "--ask-for-approval=never", "-anever", "--disable=codex_hooks"]) {
    expect(() => launchPlan("codex", ["--name", "worker", "--cwd", dir, "--", flag], env)).toThrow("identity");
  }
  for (const flag of ["--settings", "--settings=x", "--mcp-config", "--mcp-config=x", "--setting-sources", "--setting-sources=x", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode=bypassPermissions", "--bare", "-nother", "--worktree=x", "-wother"]) {
    expect(() => launchPlan("claude", ["--name", "worker", "--cwd", dir, "--", flag], env)).toThrow("identity");
  }
});

test("vendor end-of-options and literal prompt text retain their meaning", () => {
  for (const vendor of ["claude", "codex"] as const) {
    const extra = ["a prompt mentioning -cVALUE and --settings=x", "--", "-cVALUE", "--dangerously-skip-permissions"];
    expect(launchPlan(vendor, ["--name", "worker", "--cwd", dir, "--", ...extra], env).argv.slice(-extra.length)).toEqual(extra);
  }
});

test("a dead launcher identity is never inherited and cannot block a new checkout owner", () => {
  const identity = { naam: "dead-worker", rol: "agent", lead: "lead", opdracht: "", spawn_id: "dead-spawn", ts: Date.now(), relay_owner: { pid: 2147483647, start: "dead-process" } };
  schrijfIdentiteit(state, dir, identity);
  expect(leesIdentiteit(state, dir)).toBeNull();
  expect(identiteitEnv({ LAB_LEAD_STAAT: state }, join(dir, "sub"))).toEqual({});
  expect(heeftIdentiteitsbestand(state, dir)).toBe(false);
  const plan = launchPlan("codex", ["--name", "dead-worker", "--lead", "lead", "--cwd", dir], env);
  const value = plan.argv.find((arg) => arg.startsWith("mcp_servers.peers.env="))!.split("=").slice(1).join("=");
  const mcpEnv = (Bun.TOML.parse(`env=${value}`) as { env: Record<string, string> }).env;
  expect(metIdentiteit({ ...plan.env, ...mcpEnv }, dir).LAB_AGENT_NAAM).toBe("");
});

test("Codex MCP resolves a living owner while Claude retains its per-process identity", () => {
  schrijfIdentiteit(state, dir, { naam: "worker", rol: "agent", lead: "lead", opdracht: "", spawn_id: "live", ts: Date.now(), relay_owner: launcherOwner() });
  const plan = launchPlan("codex", ["--name", "worker", "--lead", "lead", "--cwd", dir], env);
  const assignment = plan.argv.find((arg) => arg.startsWith("mcp_servers.peers.env="))!;
  const mcpEnv = (Bun.TOML.parse(`env=${assignment.slice(assignment.indexOf("=") + 1)}`) as { env: Record<string, string> }).env;
  expect(metIdentiteit({ ...plan.env, ...mcpEnv }, dir)).toMatchObject({ LAB_AGENT_NAAM: "worker", LAB_LEAD_NAAM: "lead" });
  const claude = launchPlan("claude", ["--name", "worker", "--cwd", dir], env);
  const config = JSON.parse(claude.argv[claude.argv.indexOf("--mcp-config") + 1]!);
  expect(config.mcpServers.peers.env).toMatchObject({ LAB_AGENT_NAAM: "worker", LAB_AGENT_ROL: "agent" });
  for (const values of [mcpEnv, config.mcpServers.peers.env]) expect(values).toMatchObject({ BUN_OPTIONS: "", NODE_OPTIONS: "" });
});

test("launch verifies Bun >= 1.4.2 outside the checkout and uses one runtime for Claude hooks and MCP", () => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const candidate = join(bin, "bun");
  const observed = join(dir, "version-cwd");
  writeFileSync(candidate, `#!/bin/sh\npwd > '${observed}'\nprintf '1.3.0\\n'\n`);
  chmodSync(candidate, 0o755);
  expect(verifiedBun({ ...env, PATH: bin, BUN_OPTIONS: "--preload=bad", NODE_OPTIONS: "--require=bad" })).toBe(process.execPath);
  expect(readFileSync(observed, "utf8").trim()).toBe(realpathSync(join(import.meta.dir, "..")));
  writeFileSync(candidate, "#!/bin/sh\nprintf '1.4.2\\n'\n");
  expect(verifiedBun({ ...env, PATH: bin })).toBe(candidate);
  const plan = launchPlan("claude", ["--name", "worker", "--cwd", dir], env, candidate);
  const config = JSON.parse(plan.argv[plan.argv.indexOf("--mcp-config") + 1]!);
  expect(config.mcpServers.peers.command).toBe(candidate);
  expect(plan.argv[plan.argv.indexOf("--settings") + 1]!).toContain(candidate);
  expect(plan.env.LAB_LEAD_BUN).toBe(candidate);
});

test("the generated outer MCP process clears runtime options supplied by its host", () => {
  const marker = join(dir, "preload-ran");
  const preload = join(dir, "preload.ts");
  writeFileSync(preload, `await Bun.write(${JSON.stringify(marker)}, "preload ran"); console.log("PRELOAD-STDOUT");`);
  const plan = launchPlan("claude", ["--name", "worker", "--cwd", dir], env, process.execPath);
  const config = JSON.parse(plan.argv[plan.argv.indexOf("--mcp-config") + 1]!);
  const server = config.mcpServers.peers;
  const child = Bun.spawnSync([server.command, ...server.args], {
    cwd: dir, env: { ...env, BUN_OPTIONS: `--preload=${preload}`, NODE_OPTIONS: `--require=${preload}`, ...server.env },
    stdin: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n"), stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.parse(child.stdout.toString()).id).toBe(1);
});

test("live owners survive the legacy TTL; legacy, expired and malformed identities are preserved", () => {
  const base = { naam: "worker", rol: "agent", lead: "lead", opdracht: "", spawn_id: "spawn", ts: Date.now() - IDENTITEIT_MAX_MS - 1000 };
  schrijfIdentiteit(state, dir, { ...base, relay_owner: launcherOwner() });
  expect(leesIdentiteit(state, dir)?.naam).toBe("worker");
  expect(heeftIdentiteitsbestand(state, dir)).toBe(true);
  const before = readFileSync(identiteitPad(state, dir), "utf8");
  expect(withLaunchLock(state, () => ruimDodeLauncherIdentiteitenOp(state))).toEqual([]);
  expect(readFileSync(identiteitPad(state, dir), "utf8")).toBe(before);
  for (const identity of [base, { ...base, ts: Date.now() }, { ...base, relay_owner: { pid: -1, start: "unknown" } }]) {
    schrijfIdentiteit(state, dir, identity);
    const original = readFileSync(identiteitPad(state, dir), "utf8");
    expect(heeftIdentiteitsbestand(state, dir)).toBe(true);
    expect(withLaunchLock(state, () => ruimDodeLauncherIdentiteitenOp(state))).toEqual([]);
    expect(readFileSync(identiteitPad(state, dir), "utf8")).toBe(original);
  }
});

test("a reused PID with a different OS birth time is not the identity owner", () => {
  schrijfIdentiteit(state, dir, { naam: "worker", rol: "agent", lead: "", opdracht: "", spawn_id: "old", ts: Date.now(), relay_owner: { pid: process.pid, start: "a previous process" } });
  expect(leesIdentiteit(state, dir)).toBeNull();
  expect(withLaunchLock(state, () => ruimDodeLauncherIdentiteitenOp(state))).toEqual(["old"]);
  expect(existsSync(identiteitPad(state, dir))).toBe(false);
});

function fakeCodex() {
  const bin = join(dir, "bin");
  const home = join(env.HOME!, ".codex");
  mkdirSync(bin);
  mkdirSync(home);
  env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  env.CODEX_HOME = home;
  writeFileSync(join(home, "config.toml"), maakBlok({ doel: join(dir, "lab-lead-hooks"), bun: process.execPath, staat: state }));
  const register = resolveSource("scripts/lead/hooks/register.ts");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { nieuwRecord, schrijfRecord } from ${JSON.stringify(register)};
if (process.argv[2] === "app-server") {
  const config = Bun.TOML.parse(readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8"));
  const hooks = Object.entries(config.hooks).flatMap(([eventName, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ eventName, command: h.command, trustStatus: "trusted" }))));
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id) console.log(JSON.stringify({ id: request.id, result: request.method === "hooks/list" ? { data: [{ hooks }] } : {} }));
  });
} else {
  const spawn = process.env.LAB_SPAWN_ID;
  schrijfRecord(process.env.LAB_LEAD_STAAT, { ...nieuwRecord("fake-" + spawn, process.env, process.cwd(), Date.now()), vendor: "codex" });
  if (process.env.RELAY_TEST_MCP) {
    const args = process.argv.slice(2);
    const config = Bun.TOML.parse(args.filter((arg, i) => args[i - 1] === "-c").join("\\n"));
    const peers = config.mcp_servers.peers;
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: {} } };
    const mcp = Bun.spawnSync([peers.command, ...peers.args], { cwd: process.cwd(), env: { ...process.env, ...peers.env }, stdin: Buffer.from(JSON.stringify(request) + "\\n"), stdout: "pipe", stderr: "pipe" });
    if (mcp.exitCode) throw new Error(mcp.stderr.toString());
    writeFileSync(${JSON.stringify(join(dir, "mcp-result"))}, mcp.stdout);
  }
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
  writeFileSync(${JSON.stringify(join(dir, "started-"))} + process.env.LAB_AGENT_NAAM, JSON.stringify({ pid: process.pid, spawn }));
  if (process.env.RELAY_TEST_STDIN) {
    writeFileSync(${JSON.stringify(join(dir, "stdin-result"))}, await Bun.stdin.text());
    process.exit(23);
  }
  if (process.env.RELAY_TEST_EXIT) process.exit(Number(process.env.RELAY_TEST_EXIT));
  setInterval(() => {}, 1000);
}
`);
  chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(join(dir, "runner.ts"), `import { launch } from ${JSON.stringify(resolveSource("src/launch.ts"))};
try { process.exit(await launch("codex", process.argv.slice(2), process.env)); }
catch (error) { console.error(error.message); process.exit(1); }
`);
}

function resolveSource(path: string): string { return join(import.meta.dir, "..", path); }

function start(name: string, cwd = dir, extraEnv = {}, input?: string) {
  const child = Bun.spawn([process.execPath, join(dir, "runner.ts"), "--name", name, "--cwd", cwd], { cwd: dir, env: { ...env, ...extraEnv }, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "ignore", stderr: "pipe" });
  children.push(child);
  return child;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("temporary fake launcher timed out");
    await Bun.sleep(10);
  }
}

async function started(name: string) {
  const path = join(dir, `started-${name}`);
  await until(() => existsSync(path));
  const marker = JSON.parse(readFileSync(path, "utf8")) as { pid: number; spawn: string };
  vendorPids.push(marker.pid);
  return marker;
}

test("a live Codex child gets a working MCP identity from its checkout lease", async () => {
  fakeCodex();
  const child = start("worker", dir, { RELAY_TEST_EXIT: "0", RELAY_TEST_MCP: "1" });
  expect(await child.exited).toBe(0);
  const response = JSON.parse(readFileSync(join(dir, "mcp-result"), "utf8"));
  expect(response.result.isError).not.toBe(true);
  expect(response.result.content[0].text).toBe("Geen berichten.");
});

test("killing only the launcher leaves the live vendor owning its name and checkout", async () => {
  fakeCodex();
  const first = start("worker1");
  const marker = await started("worker1");
  first.kill("SIGKILL");
  await first.exited;
  expect(() => process.kill(marker.pid, 0)).not.toThrow();
  for (const name of ["worker2", "worker1", "worker2"]) {
    const second = start(name, dir, { RELAY_TEST_EXIT: "23" });
    expect(await second.exited).toBe(1);
    expect(identiteitEnv({ LAB_LEAD_STAAT: state }, dir).LAB_AGENT_NAAM).toBe("worker1");
    expect(() => process.kill(marker.pid, 0)).not.toThrow();
  }
  process.kill(marker.pid, "SIGKILL");
  await until(() => leesIdentiteit(state, dir) === null);
  const replacement = start("worker2", dir, { RELAY_TEST_EXIT: "23" });
  expect(await replacement.exited).toBe(23);
});

test("the real launch bootstrap preserves vendor stdin and exit code", async () => {
  fakeCodex();
  const child = start("worker", dir, { RELAY_TEST_STDIN: "1" }, "interactive stdin\n");
  expect(await child.exited).toBe(23);
  expect(readFileSync(join(dir, "stdin-result"), "utf8")).toBe("interactive stdin\n");
});

for (const reclaimed of [true, false]) test(`parent death before self-claim: ${reclaimed ? "reclaimer" : "bootstrap"} wins the lock`, async () => {
  fakeCodex();
  const blocked = join(dir, "bootstrap-waiting");
  const released = join(dir, "release-bootstrap");
  const bun = join(dir, "bin/bun");
  writeFileSync(bun, `#!/bin/sh
case "$*" in *--version*) exec '${process.execPath}' "$@";; esac
printf '%s' "$$" > '${blocked}'
while [ ! -f '${released}' ]; do /bin/sleep 0.01; done
exec '${process.execPath}' "$@"
`);
  chmodSync(bun, 0o755);
  const first = start("worker1");
  await until(() => existsSync(blocked));
  const bootstrapPid = Number(readFileSync(blocked, "utf8"));
  vendorPids.push(bootstrapPid);
  first.kill("SIGKILL");
  await first.exited;
  expect(existsSync(join(dir, "started-worker1"))).toBe(false);
  const replacementEnv = { PATH: `${dirname(process.execPath)}:${env.PATH}` };
  if (reclaimed) {
    const second = start("worker2", dir, replacementEnv);
    await started("worker2");
    writeFileSync(released, "release");
    await until(() => {
      const result = Bun.spawnSync(["/bin/ps", "-p", String(bootstrapPid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" });
      return result.exitCode !== 0 || result.stdout.toString().trim().startsWith("Z");
    });
    expect(existsSync(join(dir, "started-worker1"))).toBe(false);
    expect(leesIdentiteit(state, dir)?.naam).toBe("worker2");
    second.kill("SIGHUP");
    expect(await second.exited).toBe(0);
  } else {
    writeFileSync(released, "release");
    const vendor = await started("worker1");
    expect(vendor.pid).toBe(bootstrapPid);
    expect(leesIdentiteit(state, dir)?.relay_owner?.pid).toBe(bootstrapPid);
    for (const name of ["worker2", "worker1"]) {
      const second = start(name, dir, replacementEnv);
      expect(await second.exited).toBe(1);
      expect(leesIdentiteit(state, dir)?.naam).toBe("worker1");
    }
  }
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGKILL"] as const) {
  test(`${signal}: dead launcher loses identity, only its records retire, and the same name can restart`, async () => {
    fakeCodex();
    const first = start("worker");
    const marker = await started("worker");
    expect(leesIdentiteit(state, dir)?.relay_owner?.pid).toBe(marker.pid);
    schrijfRecord(state, nieuwRecord("legacy", { LAB_AGENT_NAAM: "legacy", LAB_SPAWN_ID: "legacy-spawn" }, dir, Date.now()));
    first.kill(signal);
    await first.exited;
    if (signal !== "SIGKILL") {
      expect(identiteitEnv({ LAB_LEAD_STAAT: state }, dir)).toEqual({});
      expect(existsSync(identiteitPad(state, dir))).toBe(false);
    } else expect(identiteitEnv({ LAB_LEAD_STAAT: state }, dir).LAB_AGENT_NAAM).toBe("worker");
    try { process.kill(marker.pid, "SIGKILL"); } catch {}
    await until(() => leesIdentiteit(state, dir) === null);
    const second = start("worker", dir, { RELAY_TEST_EXIT: "23" });
    expect(await second.exited).toBe(23);
    expect(existsSync(identiteitPad(state, dir))).toBe(false);
    expect(alleRecords(state).filter((r) => r.naam === "worker").every((r) => r.toestand === "weg")).toBe(true);
    expect(alleRecords(state).find((r) => r.id === "legacy")?.toestand).toBe("bezig");
  });
}

test("simultaneous names in one checkout cannot overwrite the winning live identity", async () => {
  fakeCodex();
  const first = start("one");
  const second = start("two");
  await until(() => first.exitCode !== null || second.exitCode !== null);
  const loser = first.exitCode !== null ? first : second;
  const winner = loser === first ? second : first;
  expect(await loser.exited).toBe(1);
  expect(await new Response(loser.stderr).text()).toContain("session identity");
  const name = winner === first ? "one" : "two";
  const marker = await started(name);
  expect(leesIdentiteit(state, dir)).toMatchObject({ naam: name, relay_owner: { pid: marker.pid } });
  const sub = join(dir, "sub");
  mkdirSync(sub);
  const nested = start("nested", sub);
  expect(await nested.exited).toBe(1);
  expect(leesIdentiteit(state, dir)?.naam).toBe(name);
  winner.kill("SIGHUP");
  expect(await winner.exited).toBe(0);
});

test("simultaneous starts in separate checkouts reserve names before SessionStart", async () => {
  fakeCodex();
  const one = join(dir, "project-one");
  const two = join(dir, "project-two");
  mkdirSync(one);
  mkdirSync(two);
  const first = start("same-name", one);
  const second = start("SAME-NAME", two);
  await until(() => first.exitCode !== null || second.exitCode !== null);
  const loser = first.exitCode !== null ? first : second;
  const winner = loser === first ? second : first;
  expect(await loser.exited).toBe(1);
  expect(await new Response(loser.stderr).text()).toContain("name already active");
  await started(winner === first ? "same-name" : "SAME-NAME");
  expect(alleRecords(state).filter((r) => r.toestand !== "weg")).toHaveLength(1);
  winner.kill("SIGHUP");
  expect(await winner.exited).toBe(0);
});

test("a child checkout owner also protects its parent checkout from a second launcher", async () => {
  fakeCodex();
  const sub = join(dir, "sub");
  mkdirSync(sub);
  const child = start("child", sub);
  await started("child");
  const parent = start("parent", dir);
  expect(await parent.exited).toBe(1);
  expect(await new Response(parent.stderr).text()).toContain("session identity");
  expect(leesIdentiteit(state, sub)?.naam).toBe("child");
  expect(existsSync(identiteitPad(state, dir))).toBe(false);
  child.kill("SIGHUP");
  expect(await child.exited).toBe(0);
});

test("an orphan identity without a committed reservation recovers only its own register records", async () => {
  fakeCodex();
  schrijfIdentiteit(state, dir, { naam: "worker", rol: "agent", lead: "", opdracht: "", spawn_id: "orphan", ts: Date.now(), relay_owner: { pid: 2147483647, start: "dead" } });
  schrijfRecord(state, nieuwRecord("orphan-record", { LAB_AGENT_NAAM: "worker", LAB_SPAWN_ID: "orphan" }, dir, Date.now()));
  schrijfRecord(state, nieuwRecord("legacy-record", { LAB_AGENT_NAAM: "other", LAB_SPAWN_ID: "legacy" }, dir, Date.now()));
  const replacement = start("worker", dir, { RELAY_TEST_EXIT: "0" });
  expect(await replacement.exited).toBe(0);
  expect(alleRecords(state).find((r) => r.id === "orphan-record")?.toestand).toBe("weg");
  expect(alleRecords(state).find((r) => r.id === "legacy-record")?.toestand).toBe("bezig");
});

test("SIGKILL during a reservation transaction releases the lock for the next launcher", async () => {
  const held = join(dir, "lock-held");
  const script = join(dir, "lock-owner.ts");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
import { withLaunchLock } from ${JSON.stringify(resolveSource("scripts/lead/hooks/register.ts"))};
withLaunchLock(${JSON.stringify(state)}, (db) => {
  db.query("INSERT INTO leases (spawn, payload) VALUES (?, ?)").run("uncommitted", "{}");
  writeFileSync(${JSON.stringify(held)}, "ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
});
`);
  const child = Bun.spawn([process.execPath, script], { cwd: dir, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  children.push(child);
  await until(() => existsSync(held));
  child.kill("SIGKILL");
  await child.exited;
  expect(withLaunchLock(state, (db) => db.query("SELECT * FROM leases").all())).toEqual([]);
  expect(withLaunchLock(state, () => "recovered again")).toBe("recovered again");
});

function fixtureFiles(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const st = lstatSync(path);
    result[name] = st.isSymbolicLink() ? `link:${readlinkSync(path)}` : st.isFile() ? readFileSync(path).toString("hex") : "directory";
  }
  return result;
}

function expectGuardPreserves(fixtureState: string, directory: string) {
  const before = fixtureFiles(directory);
  let entered = false;
  expect(() => withLaunchLock(fixtureState, () => { entered = true; })).toThrow("preserving existing state");
  expect(entered).toBe(false);
  expect(fixtureFiles(directory)).toEqual(before);
}

test("symlinks in the state root, intermediate parents or launchers directory cannot redirect writes", () => {
  for (const kind of ["state", "parent", "launchers"]) {
    const root = join(dir, kind);
    const outside = join(root, "external");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel"), "external bytes stay intact", { mode: 0o600 });
    const link = join(root, "redirect");
    let fixtureState: string;
    if (kind === "launchers") {
      fixtureState = join(root, "state");
      mkdirSync(fixtureState);
      symlinkSync(outside, join(fixtureState, "launchers"));
    } else {
      symlinkSync(outside, link);
      fixtureState = kind === "state" ? link : join(link, "missing", "state");
    }
    expectGuardPreserves(fixtureState, outside);
  }
});

test("an unknown existing SQLite database, its sidecars and an empty unknown directory remain untouched", () => {
  const directory = join(state, "launchers");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  expectGuardPreserves(state, directory);
  const unknown = new Database(":memory:");
  try {
    unknown.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep me')");
    writeFileSync(join(directory, "leases.sqlite"), unknown.serialize(), { mode: 0o600 });
  } finally { unknown.close(); }
  writeFileSync(join(directory, "leases.sqlite-journal"), "unknown journal", { mode: 0o600 });
  writeFileSync(join(directory, "leases.sqlite-wal"), "unknown WAL", { mode: 0o600 });
  expectGuardPreserves(state, directory);
});

test("known marker with an unknown app, schema or corrupt database refuses before file recovery", () => {
  for (const kind of ["application", "schema", "lookalike-schema", "corrupt"]) {
    const fixtureState = join(dir, kind);
    withLaunchLock(fixtureState, () => {});
    const directory = join(fixtureState, "launchers");
    const path = join(directory, "leases.sqlite");
    if (kind === "corrupt") writeFileSync(path, "not a SQLite database");
    else {
      const altered = Database.deserialize(readFileSync(path));
      try {
        altered.exec(kind === "application" ? "PRAGMA application_id = 1234" : kind === "lookalike-schema" ? "CREATE TABLE sqliteXlookalike (value TEXT)" : "CREATE TABLE unknown (value TEXT)");
        writeFileSync(path, altered.serialize());
      } finally { altered.close(); }
    }
    expectGuardPreserves(fixtureState, directory);
  }
});

test("symlink and hardlink database/journal targets and unknown sidecars stay byte-identical", () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    for (const kind of ["symlink", "hardlink", "unknown-file"]) {
      const fixtureState = join(dir, `${suffix || "db"}-${kind}`);
      withLaunchLock(fixtureState, () => {});
      const directory = join(fixtureState, "launchers");
      const target = join(dir, `external-${suffix || "db"}-${kind}`);
      writeFileSync(target, "external bytes stay intact", { mode: 0o600 });
      const candidate = join(directory, `leases.sqlite${suffix}`);
      rmSync(candidate, { force: true });
      if (kind === "symlink") symlinkSync(target, candidate);
      else if (kind === "hardlink") linkSync(target, candidate);
      else {
        // A replaced empty journal also has no ownership proof, even though SQLite accepts it.
        const replacement = join(directory, "replacement");
        writeFileSync(replacement, "", { mode: 0o600 });
        linkSync(replacement, candidate);
        rmSync(replacement);
      }
      expectGuardPreserves(fixtureState, directory);
      expect(readFileSync(target, "utf8")).toBe("external bytes stay intact");
    }
  }
});

test("corrupt ownership markers and corrupt registered journals are preserved", () => {
  for (const kind of ["marker", "journal", "short-journal", "super-journal"]) {
    const fixtureState = join(dir, kind);
    withLaunchLock(fixtureState, () => {});
    const directory = join(fixtureState, "launchers");
    const contents = kind === "short-journal" ? Buffer.alloc(8) : kind === "super-journal" ? Buffer.concat([Buffer.alloc(512), Buffer.from("d9d505f920a163d7", "hex")]) : "corrupt contents";
    writeFileSync(join(directory, kind === "marker" ? "owner.json" : "leases.sqlite-journal"), contents);
    expectGuardPreserves(fixtureState, directory);
  }
});

test("an unrecognized lease payload blocks launch and preserves the complete reservation files", async () => {
  fakeCodex();
  withLaunchLock(state, (db) => db.query("INSERT INTO leases (spawn, payload) VALUES (?, ?)").run("unknown-owner", JSON.stringify({ vendor: "unknown" })));
  const directory = join(state, "launchers");
  const before = fixtureFiles(directory);
  const child = start("worker", dir, { RELAY_TEST_EXIT: "0" });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("unrecognized Relay launcher reservation; preserving state");
  expect(fixtureFiles(directory)).toEqual(before);
  expect(existsSync(identiteitPad(state, dir))).toBe(false);
});
