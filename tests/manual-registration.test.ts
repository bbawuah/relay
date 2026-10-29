import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { alleRecords } from "../scripts/lead/hooks/register";
import { launchLeases, ownerStatus, saveLaunchLease, withLaunchLock } from "../src/identity";
import { bunArgs } from "../src/runtime";

const ROOT = resolve(import.meta.dir, "..");
type Child = { proc: Bun.Subprocess<"pipe", "pipe", "pipe">; err: Promise<string> };
let dir: string;
let state: string;
let cwd: string;
let env: Record<string, string>;
let children: Child[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-manual-registration-")));
  state = join(dir, "state");
  cwd = join(dir, "project");
  const home = join(dir, "home");
  const bin = join(dir, "prefix", "bin");
  for (const path of [cwd, home, bin]) mkdirSync(path, { recursive: true });
  env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), RELAY_STATE_DIR: state, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  children = [];
  // A real Relay launch reaches this vendor only after committing its lease.
  // stdin is the handshake: no SessionStart or record exists until we release it.
  const vendor = join(bin, "claude");
  writeFileSync(vendor, `#!${process.execPath}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(0));
console.log("reserved-before-session-start");
await Bun.stdin.text();
`);
  chmodSync(vendor, 0o755);
});

afterEach(async () => {
  for (const child of children) if (child.proc.exitCode === null) child.proc.kill("SIGTERM");
  await Promise.all(children.map((child) => deadline(child.proc.exited).catch(() => {
    child.proc.kill("SIGKILL");
    return child.proc.exited;
  })));
  rmSync(dir, { recursive: true, force: true });
});

function deadline<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated CLI handshake timed out")), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function start(args: string[]): Child {
  const proc = Bun.spawn([process.execPath, ...bunArgs(join(ROOT, "bin/relay.ts"), args)], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const err = new Response(proc.stderr).text();
  const child = { proc, err };
  children.push(child);
  return child;
}

async function result(child: ReturnType<typeof start>) {
  const [code, out, err] = await deadline(Promise.all([child.proc.exited, new Response(child.proc.stdout).text(), child.err]));
  return { code, out: out.trim(), err };
}

async function reserved(child: ReturnType<typeof start>) {
  const reader = child.proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    await deadline((async () => {
      while (!output.includes("reserved-before-session-start\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`fake vendor did not start: ${output} ${await child.err}`);
        output += decoder.decode(chunk.value, { stream: true });
      }
    })());
  } finally { reader.releaseLock(); }
  expect(alleRecords(state)).toHaveLength(0);
  const leases = withLaunchLock(state, launchLeases);
  expect(leases).toHaveLength(1);
  expect(ownerStatus(leases[0]!.owner)).toBe("alive");
}

for (const name of ["same-peer", "SAME-PEER"]) {
  test(`manual ${name} refuses a real launcher reservation before SessionStart`, async () => {
    const launch = start(["claude", "--name", "same-peer"]);
    await reserved(launch);
    const before = withLaunchLock(state, launchLeases);
    const manual = await result(start(["register", "--name", name, "--lead", "sender"]));
    expect(manual.code).toBe(1);
    expect(manual.err).toContain("session name");
    expect(manual.out).toBe("");
    expect(alleRecords(state)).toHaveLength(0);
    expect(withLaunchLock(state, launchLeases)).toEqual(before);
    launch.proc.stdin.end();
    expect(await deadline(launch.proc.exited)).toBe(0);
  });

  test(`a real launcher refuses ${name} after manual registration`, async () => {
    const manual = await result(start(["register", "--name", "same-peer", "--hold"]));
    expect(manual.code).toBe(0);
    expect(manual.out).toMatch(/^relay-[0-9a-f-]{36}$/);
    const launch = await result(start(["claude", "--name", name]));
    expect(launch.code).toBe(1);
    expect(launch.err).toContain("session name already active");
    expect(launch.out).toBe("");
    expect(alleRecords(state)).toMatchObject([{ id: manual.out, naam: "same-peer", host: "geen", inbound: { standaard: "hold" } }]);
    expect(withLaunchLock(state, launchLeases)).toEqual([]);
  });

  test(`two simultaneous manual claims for same-peer and ${name} yield one success`, async () => {
    const first = start(["register", "--name", "same-peer"]);
    const second = start(["register", "--name", name]);
    const claims = await Promise.all([result(first), result(second)]);
    expect(claims.map((claim) => claim.code).sort()).toEqual([0, 1]);
    const winner = claims.find((claim) => claim.code === 0)!;
    const loser = claims.find((claim) => claim.code !== 0)!;
    expect(loser.err).toContain("session name");
    expect(loser.out).toBe("");
    expect(alleRecords(state)).toHaveLength(1);
    expect(alleRecords(state)[0]!.id).toBe(winner.out);
    expect(withLaunchLock(state, launchLeases)).toEqual([]);
  });
}

test("manual registration ignores a provably dead lease and preserves it", async () => {
  const lease = { spawn: "dead", name: "same-peer", cwd, vendor: "claude" as const, owner: { pid: 2147483647, start: "dead-process" } };
  withLaunchLock(state, (db) => saveLaunchLease(db, lease));
  const manual = await result(start(["register", "--name", "SAME-PEER"]));
  expect(manual.code).toBe(0);
  expect(alleRecords(state)).toHaveLength(1);
  expect(withLaunchLock(state, launchLeases)).toEqual([lease]);
});

for (const payload of ["not-json", JSON.stringify({ vendor: "unknown" }), JSON.stringify({ spawn: "unknown", name: "other-name", cwd: "/", vendor: "claude", owner: { pid: -1, start: "unknown" } })]) {
  test(`manual registration preserves and refuses malformed lease ${payload}`, async () => {
    withLaunchLock(state, (db) => db.query("INSERT INTO leases (spawn, payload) VALUES (?, ?)").run("unknown", payload));
    const directory = join(state, "launchers");
    const before = snapshot(directory);
    const manual = await result(start(["register", "--name", "same-peer"]));
    expect(manual.code).toBe(1);
    expect(manual.out).toBe("");
    expect(alleRecords(state)).toEqual([]);
    expect(snapshot(directory)).toEqual(before);
  });
}

function snapshot(directory: string) {
  return Object.fromEntries(readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name)).toString("hex")]));
}

test("manual registration refuses an unknown database directory without modifying it", async () => {
  const directory = join(state, "launchers");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "leases.sqlite"), "unknown database", { mode: 0o600 });
  const before = snapshot(directory);
  const manual = await result(start(["register", "--name", "same-peer"]));
  expect(manual.code).toBe(1);
  expect(manual.err).toContain("preserving existing state");
  expect(snapshot(directory)).toEqual(before);
  expect(existsSync(join(state, "register"))).toBe(false);
});

test("manual registration refuses a symlinked reservation directory without external writes", async () => {
  const external = join(dir, "external");
  mkdirSync(external);
  mkdirSync(state);
  writeFileSync(join(external, "sentinel"), "unchanged");
  symlinkSync(external, join(state, "launchers"));
  const before = snapshot(external);
  const manual = await result(start(["register", "--name", "same-peer"]));
  expect(manual.code).toBe(1);
  expect(manual.err).toContain("preserving existing state");
  expect(snapshot(external)).toEqual(before);
  expect(existsSync(join(state, "register"))).toBe(false);
});
