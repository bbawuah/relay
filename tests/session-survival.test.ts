import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunArgs } from "../src/runtime";
import { launcherOwner, leesIdentiteit, schrijfIdentiteit, identiteitPad, ververseIdentiteit, withLaunchLock } from "../scripts/lead/hooks/register";
import { deleteLaunchLease, saveLaunchLease, type LaunchLease } from "../src/identity";

test("real Bun execve preserves PID, OS birth time, stdin and exit status", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-execve-")));
  try {
    const register = join(import.meta.dir, "../scripts/lead/hooks/register.ts");
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    const target = join(dir, "vendor.ts");
    writeFileSync(target, `import { launcherOwner } from ${JSON.stringify(register)};
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(after)}, JSON.stringify({ owner: launcherOwner(), stdin: await Bun.stdin.text() }));
process.exit(23);`);
    const bootstrap = join(dir, "bootstrap.ts");
    writeFileSync(bootstrap, `import { launcherOwner } from ${JSON.stringify(register)};
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(before)}, JSON.stringify(launcherOwner()));
process.execve(process.execPath, ${JSON.stringify([process.execPath, ...bunArgs(target)])}, process.env);`);
    const child = Bun.spawn([process.execPath, ...bunArgs(bootstrap)], {
      cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin" },
      stdin: Buffer.from("interactive input\n"), stdout: "ignore", stderr: "pipe",
    });
    expect(await child.exited).toBe(23);
    const owner = JSON.parse(readFileSync(before, "utf8"));
    expect(owner.pid).toBe(child.pid);
    expect(JSON.parse(readFileSync(after, "utf8"))).toEqual({ owner, stdin: "interactive input\n" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const changed of ["missing lease", "changed lease", "missing identity", "changed identity"]) {
  test(`trusted bootstrap refuses a ${changed} before starting vendor code`, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-bootstrap-")));
    try {
      const state = join(dir, "state");
      const lease: LaunchLease = { spawn: "pending", name: "worker", cwd: dir, vendor: "codex", owner: launcherOwner() };
      withLaunchLock(state, (db) => saveLaunchLease(db, lease));
      schrijfIdentiteit(state, dir, { naam: "worker", rol: "agent", lead: "", opdracht: "", spawn_id: lease.spawn, ts: Date.now(), relay_owner: lease.owner });
      if (changed === "missing lease") withLaunchLock(state, (db) => deleteLaunchLease(db, lease.spawn));
      if (changed === "changed lease") withLaunchLock(state, (db) => {
        deleteLaunchLease(db, lease.spawn);
        saveLaunchLease(db, { ...lease, owner: { ...lease.owner, start: "different process" } });
      });
      if (changed === "missing identity") rmSync(identiteitPad(state, dir));
      if (changed === "changed identity") schrijfIdentiteit(state, dir, { naam: "replacement", rol: "agent", lead: "", opdracht: "", spawn_id: "different", ts: Date.now(), relay_owner: lease.owner });
      const marker = join(dir, "vendor-started");
      const preload = join(dir, "preload.ts");
      writeFileSync(preload, `await Bun.write(${JSON.stringify(marker)}, "unsafe preload");`);
      writeFileSync(join(dir, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
      const child = Bun.spawn([process.execPath, ...bunArgs(join(import.meta.dir, "../src/session-child.ts"), [JSON.stringify({ state, lease, argv: ["/bin/sh", "-c", `printf started > '${marker}'`] })])], {
        cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin", BUN_OPTIONS: "", NODE_OPTIONS: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("changed or disappeared");
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("legacy upkeep reclaims a dead identity lock without creating SQLite", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-identity-lock-")));
  try {
    const state = join(dir, "state");
    const now = Date.now();
    schrijfIdentiteit(state, dir, { naam: "legacy", rol: "agent", lead: "", opdracht: "", spawn_id: "legacy", ts: now - 120_000 });
    const slot = join(state, "identiteit/.maintenance-lock");
    mkdirSync(slot, { mode: 0o700 });
    writeFileSync(join(slot, crypto.randomUUID()), JSON.stringify({ pid: 2147483647, start: "dead" }), { mode: 0o600 });
    ververseIdentiteit(state, dir, "legacy", now);
    expect(leesIdentiteit(state, dir, now)?.ts).toBe(now);
    expect(existsSync(slot)).toBe(false);
    expect(existsSync(join(state, "launchers"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const operation of ["ververseIdentiteit", "wisIdentiteit"]) {
  test(`a delayed legacy ${operation} preserves the replacement managed identity`, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-identity-race-")));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const state = join(dir, "state");
      const now = Date.now();
      schrijfIdentiteit(state, dir, { naam: "old", rol: "agent", lead: "", opdracht: "", spawn_id: "old", ts: now - 120_000 });
      const slot = join(state, "identiteit/.maintenance-lock"), token = crypto.randomUUID();
      mkdirSync(slot, { mode: 0o700 });
      writeFileSync(join(slot, token), JSON.stringify(launcherOwner()), { mode: 0o600 });
      const ready = join(dir, "ready");
      const script = join(dir, "maintenance.ts");
      writeFileSync(script, `import { ${operation} } from ${JSON.stringify(join(import.meta.dir, "../scripts/lead/hooks/register.ts"))};
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)}, "ready");
try { ${operation}(${JSON.stringify(state)}, ${JSON.stringify(dir)}, "old", ${now}); }
catch (error) { if (!error.message.includes("maintenance lock timed out")) throw error; }`);
      child = Bun.spawn([process.execPath, ...bunArgs(script)], { cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const deadline = Date.now() + 2000;
      while (!existsSync(ready)) { if (Date.now() > deadline) throw new Error("maintenance fixture timeout"); await Bun.sleep(5); }
      await Bun.sleep(50);
      const replacement = { naam: "new", rol: "agent", lead: "", opdracht: "", spawn_id: "new", ts: now, relay_owner: launcherOwner() };
      // The fixture owns the identity lock while publishing its successor.
      const temporary = join(dir, "replacement");
      writeFileSync(temporary, JSON.stringify(replacement), { mode: 0o600 });
      renameSync(temporary, identiteitPad(state, dir));
      unlinkSync(join(slot, token)); rmdirSync(slot);
      expect(await child.exited).toBe(0);
      expect(leesIdentiteit(state, dir, now)).toEqual(replacement);
      expect(existsSync(join(state, "launchers"))).toBe(false);
    } finally {
      if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
