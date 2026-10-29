import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geenWekker, maakBus } from "../peers/bus";
import { type Bus, MAX_WACHTRIJ, seintje } from "../peers/types";
import { type Opties, verwerk } from "./hook";
import { identiteitPad, launcherOwner, leesIdentiteit, leesRecord, schrijfIdentiteit, withLaunchLock } from "./register";

// Hooks → bus: seintje bij UserPromptSubmit en Stop, idleGemeld bij Stop en SessionEnd. Wegwerpmap, nep-klok, echte bus.

const T0 = 1_700_000_000_000;
let dir: string;
let staat: string;
let klok: number;
let bus: Bus;
let opt: Opties;

const env = (naam: string, rol: string, lead: string) => ({ HOME: dir, LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: naam, LAB_AGENT_ROL: rol, LAB_LEAD_NAAM: lead, LAB_OPDRACHT: "/x/OPDRACHT.md" });
const W = () => env("w1", "agent", "lead-x");
const L = () => env("lead-x", "lead", "");
const inv = (sessie: string, extra: Record<string, unknown> = {}) => ({ session_id: sessie, cwd: `/w/${sessie}`, ...extra });
const reden = (stdout: string): string => JSON.parse(stdout).reason;
const context = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lead-hook-bus-")));
  staat = join(dir, "staat");
  klok = T0;
  bus = maakBus({ staat, nu: () => klok, wekker: geenWekker, machine: "testmachine", wacht: async (ms) => void (klok += ms) });
  opt = { nu: () => klok, bus };
  await verwerk("SessionStart", inv("w1", { source: "startup" }), W(), opt);
  await verwerk("SessionStart", inv("lead-x", { source: "startup" }), L(), opt);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hooks → bus", () => {
  for (const kind of ["unmanaged", "other-spawn", "managed-corrupt", "managed-symlink"]) {
    test(`optional identity maintenance cannot abort real core events: ${kind}`, async () => {
      const maintenanceEnv = { ...W(), LAB_SPAWN_ID: "owned-spawn" };
      const cwd = join(dir, "checkout");
      mkdirSync(cwd);
      const managed = kind.startsWith("managed-");
      if (kind === "managed-symlink") {
        const alias = join(dir, "alias");
        symlinkSync(staat, alias);
        maintenanceEnv.LAB_LEAD_STAAT = alias;
      }
      if (managed || kind === "other-spawn") schrijfIdentiteit(staat, cwd, {
        naam: "w1", rol: "agent", lead: "lead-x", opdracht: "", ts: T0 - 120_000,
        spawn_id: managed ? "owned-spawn" : "another-spawn", relay_owner: launcherOwner(),
      });
      const identity = managed ? readFileSync(identiteitPad(staat, cwd)) : null;
      if (kind !== "managed-symlink") {
        mkdirSync(join(staat, "launchers"), { mode: 0o700 });
        writeFileSync(join(staat, "launchers/leases.sqlite"), "unknown database: preserve", { mode: 0o600 });
      }
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await verwerk("Stop", inv("w1", { cwd, stop_hook_active: true }), maintenanceEnv, opt);
        expect(leesRecord(staat, "w1")?.toestand).toBe("idle");
        await verwerk("UserPromptSubmit", inv("w1", { cwd }), maintenanceEnv, opt);
        expect(leesRecord(staat, "w1")?.toestand).toBe("bezig");
        await bus.send("lead-x", "w1", "unread notice survives maintenance failure");
        expect(reden((await verwerk("Stop", inv("w1", { cwd }), maintenanceEnv, opt)).stdout)).toBe(seintje(1));
        expect(bus.notifyWhenIdle("lead-x", "w1").ok).toBe(true);
        await verwerk("SessionEnd", inv("w1", { cwd }), maintenanceEnv, opt);
        expect(leesRecord(staat, "w1")?.toestand).toBe("weg");
        expect(bus.inbox("lead-x").some((entry) => entry.soort === "idle" && entry.tekst === "w1 is weg")).toBe(true);
        if (managed) {
          expect(errors).toHaveBeenCalled();
          expect(readFileSync(identiteitPad(staat, cwd))).toEqual(identity!);
          if (kind !== "managed-symlink") {
            const logs = readdirSync(join(staat, "identiteit")).filter((name) => name.endsWith(".error"));
            expect(logs).toHaveLength(1);
            const log = join(staat, "identiteit", logs[0]!);
            expect(JSON.parse(readFileSync(log, "utf8")).kind).toBe("relay-identity-maintenance-error-v1");
            expect(statSync(log).mode & 0o777).toBe(0o600);
          }
        } else expect(errors).not.toHaveBeenCalled();
        if (kind !== "managed-symlink") expect(readFileSync(join(staat, "launchers/leases.sqlite"), "utf8")).toBe("unknown database: preserve");
        else expect(existsSync(join(staat, "launchers"))).toBe(false);
      } finally { errors.mockRestore(); }
    });
  }

  test("an unmanaged spawn creates no reservation DB for any core event", async () => {
    const unmanaged = { ...W(), LAB_SPAWN_ID: "legacy-spawn" };
    for (const event of ["UserPromptSubmit", "Stop", "SessionEnd"]) await verwerk(event, inv("w1"), unmanaged, opt);
    expect(existsSync(join(staat, "launchers"))).toBe(false);
  });

  test("busy managed DB maintenance cannot consume the hook budget or cancel core events", async () => {
    const cwd = join(dir, "checkout");
    mkdirSync(cwd);
    const managedEnv = { ...W(), LAB_SPAWN_ID: "managed-spawn" };
    schrijfIdentiteit(staat, cwd, { naam: "w1", rol: "agent", lead: "lead-x", opdracht: "", spawn_id: "managed-spawn", ts: T0 - 120_000, relay_owner: launcherOwner() });
    withLaunchLock(staat, () => {});
    const database = join(staat, "launchers/leases.sqlite");
    const before = readFileSync(database);
    const ready = join(dir, "db-held"), script = join(dir, "hold-db.ts");
    writeFileSync(script, `import { withLaunchLock } from ${JSON.stringify(join(import.meta.dir, "register.ts"))};
import { writeFileSync } from "node:fs";
withLaunchLock(${JSON.stringify(staat)}, () => { writeFileSync(${JSON.stringify(ready)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); });`);
    const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", script], { cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const deadline = Date.now() + 2000;
      while (!existsSync(ready)) { if (Date.now() > deadline) throw new Error("DB holder timed out"); await Bun.sleep(5); }
      const started = Date.now();
      await verwerk("UserPromptSubmit", inv("w1", { cwd }), managedEnv, opt);
      expect(leesRecord(staat, "w1")?.toestand).toBe("bezig");
      await bus.send("lead-x", "w1", "notice");
      expect(reden((await verwerk("Stop", inv("w1", { cwd }), managedEnv, opt)).stdout)).toBe(seintje(1));
      expect(bus.notifyWhenIdle("lead-x", "w1").ok).toBe(true);
      await verwerk("SessionEnd", inv("w1", { cwd }), managedEnv, opt);
      expect(leesRecord(staat, "w1")?.toestand).toBe("weg");
      expect(bus.inbox("lead-x").some((entry) => entry.soort === "idle" && entry.tekst === "w1 is weg")).toBe(true);
      expect(Date.now() - started).toBeLessThan(500);
      expect(errors).toHaveBeenCalled();
      expect(readFileSync(database)).toEqual(before);
    } finally {
      errors.mockRestore();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });

  for (const database of ["absent", "unknown"]) {
    test(`matching legacy identity refreshes and cleans up without SQLite: ${database}`, async () => {
      const cwd = join(dir, "legacy-checkout");
      mkdirSync(cwd);
      schrijfIdentiteit(staat, cwd, { naam: "w1", rol: "agent", lead: "lead-x", opdracht: "", spawn_id: "legacy-spawn", ts: T0 - 120_000 });
      const legacyEnv = { ...W(), LAB_SPAWN_ID: "legacy-spawn" };
      const db = join(staat, "launchers/leases.sqlite");
      if (database === "unknown") {
        mkdirSync(join(staat, "launchers"), { mode: 0o700 });
        writeFileSync(db, "keep unknown DB byte identical", { mode: 0o600 });
      }
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await verwerk("UserPromptSubmit", inv("w1", { cwd }), legacyEnv, opt);
        expect(leesIdentiteit(staat, cwd, klok)?.ts).toBe(klok);
        await bus.send("lead-x", "w1", "notice");
        expect(reden((await verwerk("Stop", inv("w1", { cwd }), legacyEnv, opt)).stdout)).toBe(seintje(1));
        expect(bus.notifyWhenIdle("lead-x", "w1").ok).toBe(true);
        await verwerk("SessionEnd", inv("w1", { cwd }), legacyEnv, opt);
        expect(existsSync(identiteitPad(staat, cwd))).toBe(false);
        expect(leesRecord(staat, "w1")?.toestand).toBe("weg");
        expect(bus.inbox("lead-x").some((entry) => entry.soort === "idle" && entry.tekst === "w1 is weg")).toBe(true);
        expect(errors).not.toHaveBeenCalled();
        if (database === "absent") expect(existsSync(join(staat, "launchers"))).toBe(false);
        else expect(readFileSync(db, "utf8")).toBe("keep unknown DB byte identical");
      } finally { errors.mockRestore(); }
    });
  }

  test("UserPromptSubmit zonder post: geen extra context", async () => {
    const u = await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    expect(u.stdout).toBe("");
  });

  test("UserPromptSubmit met post: alleen het seintje, nooit de inhoud", async () => {
    await bus.send("lead-x", "w1", "geheime inhoud van het bericht");
    const u = await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    expect(context(u.stdout)).toBe(seintje(1));
    expect(u.stdout).not.toContain("geheime inhoud");
  });

  test("de lead krijgt zijn meldingen én het seintje in één context", async () => {
    await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    await verwerk("Stop", inv("w1", { stop_hook_active: true }), W(), opt); // idle-melding in de inbox van lead-x
    await bus.send("w1", "lead-x", "vraag van een werker");
    const u = await verwerk("UserPromptSubmit", inv("lead-x"), L(), opt);
    expect(context(u.stdout)).toContain("Meldingen van je sessies:");
    expect(context(u.stdout)).toContain(seintje(1));
  });

  test("Stop blokkeert één keer met het seintje; de tweede stop (stop_hook_active) gaat door", async () => {
    await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    await bus.send("lead-x", "w1", "kijk hier even naar");
    const eerste = await verwerk("Stop", inv("w1"), W(), opt);
    expect(JSON.parse(eerste.stdout).decision).toBe("block");
    expect(reden(eerste.stdout)).toBe(seintje(1));
    expect(reden(eerste.stdout)).not.toContain("kijk hier");
    expect(leesRecord(staat, "w1")?.toestand).toBe("bezig"); // nog niet gestopt
    const tweede = await verwerk("Stop", inv("w1", { stop_hook_active: true }), W(), opt);
    expect(tweede.stdout).toBe("");
    expect(leesRecord(staat, "w1")?.toestand).toBe("idle");
  });

  test("na inbox + ack geen seintje meer bij Stop", async () => {
    await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    await bus.send("lead-x", "w1", "hoi");
    const ids = bus.inbox("w1").map((e) => e.id);
    bus.ack("w1", ids);
    expect((await verwerk("Stop", inv("w1"), W(), opt)).stdout).toBe("");
  });

  test("de rapport-gate blijft aan en krijgt het seintje erbij; de gate telt zijn blokkades", async () => {
    await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    await verwerk("PreToolUse", inv("w1", { tool_name: "Bash" }), W(), opt);
    await bus.send("lead-x", "w1", "hoi");
    const u = await verwerk("Stop", inv("w1"), W(), opt);
    expect(reden(u.stdout)).toContain("Je stopt zonder rapport aan lead-x");
    expect(reden(u.stdout)).toContain(seintje(1));
    expect(leesRecord(staat, "w1")?.blokkades).toBe(1);
  });

  test("een rapport via peers.send naar de eigen lead telt voor de gate (Codex en Claude)", async () => {
    for (const [sessie, bron] of [["w1", "claude"], ["w1", "codex"]] as const) {
      await verwerk("UserPromptSubmit", inv(sessie), W(), { ...opt, bron });
      await verwerk("PreToolUse", inv(sessie, { tool_name: "Bash" }), W(), { ...opt, bron });
      await verwerk("PostToolUse", inv(sessie, { tool_name: "mcp__peers__send", tool_input: { naar: "lead-x", tekst: "klaar" } }), W(), { ...opt, bron });
      const u = await verwerk("Stop", inv(sessie), W(), { ...opt, bron });
      expect(u.stdout).toBe("");
      expect(leesRecord(staat, sessie)?.toestand).toBe("klaar");
    }
  });

  test("een lead met post: Stop blokkeert één keer met het seintje", async () => {
    await bus.send("w1", "lead-x", "vraag");
    const eerste = await verwerk("Stop", inv("lead-x"), L(), opt);
    expect(reden(eerste.stdout)).toContain(seintje(1));
    expect((await verwerk("Stop", inv("lead-x", { stop_hook_active: true }), L(), opt)).stdout).toBe("");
  });

  test("Stop roept idleGemeld aan: een abonnee krijgt één idle-envelop; SessionEnd meldt weg", async () => {
    expect(bus.notifyWhenIdle("lead-x", "w1")).toMatchObject({ ok: true, al_idle: false });
    await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    await verwerk("Stop", inv("w1"), W(), opt);
    const inbox = bus.inbox("lead-x");
    expect(inbox.filter((e) => e.soort === "idle").map((e) => e.tekst)).toEqual(["w1 is idle"]);
    // het abonnement is eenmalig: een tweede Stop geeft niets meer
    bus.ack("lead-x", inbox.map((e) => e.id));
    await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    await verwerk("Stop", inv("w1"), W(), opt);
    expect(bus.inbox("lead-x").filter((e) => e.soort === "idle")).toEqual([]);
    expect(bus.notifyWhenIdle("lead-x", "w1")).toMatchObject({ ok: true, al_idle: true });
    const abonnee = bus.inbox("lead-x");
    bus.ack("lead-x", abonnee.map((e) => e.id));
    await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    expect(bus.notifyWhenIdle("lead-x", "w1")).toMatchObject({ ok: true });
    await verwerk("SessionEnd", inv("w1"), W(), opt);
    expect(bus.inbox("lead-x").some((e) => e.soort === "idle" && e.tekst === "w1 is weg")).toBe(true);
  });

  test("zonder bus (ontbreekt of faalt) doen de hooks het oude werk en gooien ze niet", async () => {
    const kapot = { ...bus, list: () => { throw new Error("stuk"); }, ongelezen: () => { throw new Error("stuk"); }, idleGemeld: async () => { throw new Error("stuk"); } } as unknown as Bus;
    for (const b of [null, kapot]) {
      const o = { ...opt, bus: b };
      expect((await verwerk("UserPromptSubmit", inv("w1"), W(), o)).stdout).toBe("");
      expect((await verwerk("Stop", inv("w1"), W(), o)).code).toBe(0);
      expect((await verwerk("SessionEnd", inv("w1"), W(), o)).code).toBe(0);
    }
  });

  test("een volle brievenbus geeft het aantal van de bus (hoogstens MAX_WACHTRIJ)", async () => {
    expect(MAX_WACHTRIJ).toBeGreaterThan(0);
    await bus.send("lead-x", "w1", "een");
    klok += 61_000;
    await bus.send("lead-x", "w1", "twee");
    const u = await verwerk("UserPromptSubmit", inv("w1"), W(), opt);
    expect(context(u.stdout)).toBe(seintje(2));
  });

  test("Stop blokkeert alleen bij een stijging sinds het laatste seintje: een sessie die niet leest krijgt geen extra ronde per Stop", async () => {
    await bus.send("lead-x", "w1", "een");
    const eerste = await verwerk("Stop", inv("w1"), W(), opt);
    expect(reden(eerste.stdout)).toBe(seintje(1));
    expect(leesRecord(staat, "w1")?.seintje_n).toBe(1);
    // dezelfde stand, nieuwe beurt, niet gelezen: geen block meer
    const nogmaals = await verwerk("Stop", inv("w1"), W(), opt);
    expect(nogmaals.stdout).toBe("");
    // een nieuw bericht (stijging): weer één block
    klok += 61_000;
    await bus.send("lead-x", "w1", "twee");
    const derde = await verwerk("Stop", inv("w1"), W(), opt);
    expect(reden(derde.stdout)).toBe(seintje(2));
    // gelezen en leeg: de teller gaat terug, en een volgend bericht blokkeert weer
    bus.ack("w1", bus.inbox("w1").map((e) => e.id));
    expect((await verwerk("Stop", inv("w1"), W(), opt)).stdout).toBe("");
    expect(leesRecord(staat, "w1")?.seintje_n).toBe(0);
    klok += 61_000;
    await bus.send("lead-x", "w1", "drie");
    expect(reden((await verwerk("Stop", inv("w1"), W(), opt)).stdout)).toBe(seintje(1));
  });

  test("het seintje van UserPromptSubmit telt als gezien: Stop met dezelfde stand blokkeert niet", async () => {
    await bus.send("lead-x", "w1", "een");
    expect(context((await verwerk("UserPromptSubmit", inv("w1"), W(), opt)).stdout)).toBe(seintje(1));
    expect((await verwerk("Stop", inv("w1"), W(), opt)).stdout).toBe("");
  });

  test("Stop en SessionEnd wachten hoogstens op hun budget, ook als de bus in het wekvenster wacht (echte wachttijd-route)", async () => {
    // Een bus waarvan de wekwacht nooit eindigt: zonder tijdsgrens hangt de hook (in het echt tot 5 s, tegen een timeout van 5 s).
    let wachtAangeroepen = 0;
    const hangend = maakBus({ staat, nu: () => klok, wekker: geenWekker, machine: "testmachine", wacht: () => (wachtAangeroepen++, new Promise<void>(() => {})) });
    const budgetten: number[] = [];
    const o: Opties = { nu: () => klok, bus: hangend, budget: async (ms) => void budgetten.push(ms) };
    // lead-x kreeg net een wek (venster open) en wacht op w1; w1 stopt nu binnen dat venster
    await hangend.send("w1", "lead-x", "hoi"); // eerste wek: nu, zet het venster
    expect(hangend.notifyWhenIdle("lead-x", "w1")).toMatchObject({ ok: true, al_idle: false });
    const stop = await verwerk("Stop", inv("w1"), W(), o);
    expect(stop.code).toBe(0);
    expect(wachtAangeroepen).toBe(1); // de bus zit echt in zijn wekwacht, en de hook kwam toch terug
    expect(budgetten).toEqual([1000]);
    // SessionEnd: een tweede abonnement, kleiner budget
    await verwerk("UserPromptSubmit", inv("w1"), W(), o);
    expect(hangend.notifyWhenIdle("lead-x", "w1")).toMatchObject({ ok: true });
    const einde = await verwerk("SessionEnd", inv("w1"), W(), o);
    expect(einde.code).toBe(0);
    expect(budgetten.at(-1)).toBe(500);
  });
});
