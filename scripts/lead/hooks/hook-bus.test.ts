import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geenWekker, maakBus } from "../peers/bus";
import { type Bus, MAX_WACHTRIJ, seintje } from "../peers/types";
import { type Opties, verwerk } from "./hook";
import { leesRecord } from "./register";

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
  dir = mkdtempSync(join(tmpdir(), "lead-hook-bus-"));
  staat = join(dir, "staat");
  klok = T0;
  bus = maakBus({ staat, nu: () => klok, wekker: geenWekker, machine: "testmachine", wacht: async (ms) => void (klok += ms) });
  opt = { nu: () => klok, bus };
  await verwerk("SessionStart", inv("w1", { source: "startup" }), W(), opt);
  await verwerk("SessionStart", inv("lead-x", { source: "startup" }), L(), opt);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hooks → bus", () => {
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
    const kapot = { ...bus, list: () => { throw new Error("stuk"); }, idleGemeld: async () => { throw new Error("stuk"); } } as unknown as Bus;
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
});
