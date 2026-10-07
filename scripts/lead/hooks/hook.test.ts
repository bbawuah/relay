import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BLOKKADES, type Opties, verwerk, wekker } from "./hook";
import { gelezenOffset, inboxMelding, inboxPad, leesRecord } from "./register";

// Alles draait in een wegwerpmap (LAB_LEAD_STAAT); de echte ~/.claude en ~/.local/state blijven ongemoeid.

const HOOK_SH = join(import.meta.dir, "hook.sh");
const T0 = 1_700_000_000_000;

let dir: string;
let staat: string;
let klok: number;

const nu = () => klok;
const opt: Opties = { nu };

function omgeving(extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: dir, LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: "w2", LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "lead", LAB_OPDRACHT: "/x/OPDRACHT.md", ...extra };
}
const LEAD = () => omgeving({ LAB_AGENT_NAAM: "lead", LAB_AGENT_ROL: "lead", LAB_LEAD_NAAM: "" });

const inv = (extra: Record<string, unknown> = {}) => ({ session_id: "s1", cwd: "/w/w2", ...extra });
function stuurTool(env: Record<string, string>, tool = "Bash", extra: Record<string, unknown> = {}) {
  return verwerk("PreToolUse", inv({ tool_name: tool, ...extra }), env, opt);
}
function inboxRegels(lead = "lead"): { van: string; tekst: string }[] {
  const p = inboxPad(staat, lead);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-hooks-"));
  staat = join(dir, "staat");
  klok = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hook.sh", () => {
  function nepBun(): string {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bun"), `#!/bin/sh\ntouch "${join(dir, "markeer")}"\n`);
    chmodSync(join(bin, "bun"), 0o755);
    return bin;
  }
  function draai(env: Record<string, string>, stdin = "{}") {
    const p = Bun.spawnSync(["/bin/sh", HOOK_SH, ...(env.ARG ? [env.ARG] : [])], { env, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test("a) lege LAB_AGENT_ROL: stopt in sh, bun wordt niet gestart", () => {
    const bin = nepBun();
    const r = draai({ PATH: `${bin}:/usr/bin:/bin`, LAB_LEAD_STAAT: staat, LAB_AGENT_ROL: "" });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "markeer"))).toBe(false);
    // ook als de variabele helemaal ontbreekt
    expect(draai({ PATH: `${bin}:/usr/bin:/bin` }).code).toBe(0);
    expect(existsSync(join(dir, "markeer"))).toBe(false);
  });

  test("a) controle: met een rol wordt bun wel gestart (anders bewijst de test niets)", () => {
    const bin = nepBun();
    expect(draai({ PATH: `${bin}:/usr/bin:/bin`, LAB_AGENT_ROL: "agent" }).code).toBe(0);
    expect(existsSync(join(dir, "markeer"))).toBe(true);
  });

  test("LAB_LEAD_BUN wint van PATH; een ontbrekende bun geeft exit 0", () => {
    const bin = nepBun();
    expect(draai({ PATH: `${bin}:/usr/bin:/bin`, LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: join(dir, "bestaat-niet") }).code).toBe(0);
    expect(existsSync(join(dir, "markeer"))).toBe(false);
    expect(draai({ PATH: "/nergens", LAB_AGENT_ROL: "agent" }).code).toBe(0);
  });

  test("exit 2 van de wekker gaat door met stderr; JSON van de gate op stdout; kapotte stdin = exit 0", () => {
    const env = { PATH: "/usr/bin:/bin", LAB_LEAD_BUN: process.execPath, LAB_LEAD_STAAT: staat, HOME: dir };
    inboxMelding(staat, "lead", "w2", "w2 klaar (rapport binnen)", T0);
    const w = draai({ ...env, LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: "lead", ARG: "wekker", LAB_WEKKER_INTERVAL_MS: "1", LAB_WEKKER_MAX_MS: "5" });
    expect(w.code).toBe(2);
    expect(w.err).toContain("w2 klaar");

    const sessie = { session_id: "s9", cwd: "/w" };
    const agent = { ...env, LAB_AGENT_ROL: "agent", LAB_AGENT_NAAM: "w9", LAB_LEAD_NAAM: "lead" };
    draai(agent, JSON.stringify({ ...sessie, hook_event_name: "PreToolUse", tool_name: "Bash" }));
    const stop = draai(agent, JSON.stringify({ ...sessie, hook_event_name: "Stop", stop_hook_active: false }));
    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.out).decision).toBe("block");

    const kapot = draai(agent, "{niet json");
    expect(kapot).toEqual({ code: 0, out: "", err: "" });
  });

  test("wekker zonder inbox-regels geeft na het maximum op met exit 0", () => {
    const env = { PATH: "/usr/bin:/bin", LAB_LEAD_BUN: process.execPath, LAB_LEAD_STAAT: staat, HOME: dir, LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: "lead", ARG: "wekker", LAB_WEKKER_INTERVAL_MS: "1", LAB_WEKKER_MAX_MS: "3" };
    expect(draai(env).code).toBe(0);
  });
});

describe("register (H1-H5, H8-H10)", () => {
  test("rol leeg of onbekend: er wordt niets geschreven", async () => {
    await verwerk("SessionStart", inv(), omgeving({ LAB_AGENT_ROL: "" }), opt);
    await verwerk("SessionStart", inv(), omgeving({ LAB_AGENT_ROL: "gast" }), opt);
    expect(existsSync(staat)).toBe(false);
  });

  test("H1 SessionStart maakt een record met de vaste velden", async () => {
    await verwerk("SessionStart", inv(), omgeving({ TMUX_PANE: "%7" }), opt);
    const r = leesRecord(staat, "s1");
    expect(r).toEqual({
      id: "s1", soort: "sessie", naam: "w2", rol: "agent", lead: "lead", opdracht: "/x/OPDRACHT.md", cwd: "/w/w2", pane: "%7",
      toestand: "bezig", sinds: T0, start: T0, einde: null, laatste_tool: null, laatste_tool_om: null, tools_in_beurt: 0,
      rapport_om: null, rapport_in_beurt: false, vrij: false, blokkades: 0, ouder: null, agent_type: null,
    });
    expect(statSync(staat).mode & 0o077).toBe(0);
    expect(statSync(join(staat, "register", "s1.json")).mode & 0o077).toBe(0);
  });

  test("H3 PreToolUse telt tools en onthoudt alleen de toolnaam; een kapot record wordt overschreven", async () => {
    const env = omgeving();
    await verwerk("SessionStart", inv(), env, opt);
    klok += 5000;
    await stuurTool(env, "Edit", { tool_input: { file_path: "/geheim" } });
    await stuurTool(env, "Bash");
    const r = leesRecord(staat, "s1");
    expect(r?.tools_in_beurt).toBe(2);
    expect(r?.laatste_tool).toBe("Bash");
    expect(r?.laatste_tool_om).toBe(T0 + 5000);
    writeFileSync(join(staat, "register", "s1.json"), "{kapot");
    await stuurTool(env, "Read");
    expect(leesRecord(staat, "s1")?.tools_in_beurt).toBe(1);
  });

  test("H4 SendMessage aan de eigen lead: alleen `to` en een boolean vrij", async () => {
    const env = omgeving();
    await stuurTool(env, "SendMessage");
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "iemand-anders", message: "vrij" } }), env, opt);
    expect(leesRecord(staat, "s1")?.rapport_in_beurt).toBe(false);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "PR 12, sha abc, geen open punten" } }), env, opt);
    let r = leesRecord(staat, "s1");
    expect(r?.rapport_in_beurt).toBe(true);
    expect(r?.vrij).toBe(false);
    expect(r?.rapport_om).toBe(T0);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "Ik ben vrij voor werk" } }), env, opt);
    r = leesRecord(staat, "s1");
    expect(r?.vrij).toBe(true);
    // "vrijdag" is niet het woord vrij
    await verwerk("UserPromptSubmit", inv(), env, opt);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "vrijdag klaar" } }), env, opt);
    expect(leesRecord(staat, "s1")?.vrij).toBe(false);
  });

  test("H5 Notification: goedkeuring met melding in de inbox; idle_prompt alleen de toestand", async () => {
    const env = omgeving();
    await stuurTool(env, "Bash");
    await verwerk("Notification", inv({ notification_type: "permission_prompt", message: "Claude needs permission" }), env, opt);
    expect(leesRecord(staat, "s1")?.toestand).toBe("goedkeuring");
    expect(inboxRegels().map((x) => x.tekst)).toEqual(["w2 wacht op goedkeuring (tool Bash)"]);
    await verwerk("Notification", inv({ notification_type: "idle_prompt" }), env, opt);
    expect(leesRecord(staat, "s1")?.toestand).toBe("idle");
    expect(inboxRegels()).toHaveLength(1);
    await stuurTool(env, "Bash");
    expect(leesRecord(staat, "s1")?.toestand).toBe("bezig");
  });

  test("H8 StopFailure en H10 SessionEnd", async () => {
    const env = omgeving();
    await verwerk("SessionStart", inv(), env, opt);
    await verwerk("StopFailure", inv(), env, opt);
    expect(leesRecord(staat, "s1")?.toestand).toBe("vastgelopen");
    expect(inboxRegels()[0].tekst).toContain("vastgelopen");
    klok += 1000;
    await verwerk("SessionEnd", inv(), env, opt);
    const r = leesRecord(staat, "s1");
    expect(r?.toestand).toBe("weg");
    expect(r?.einde).toBe(T0 + 1000);
  });

  test("H9 subagents: eigen record met ouder; tool-events met agent_id raken de ouder niet", async () => {
    const env = omgeving();
    await verwerk("SessionStart", inv(), env, opt);
    await verwerk("SubagentStart", inv({ agent_id: "a1", agent_type: "general-purpose" }), env, opt);
    await stuurTool(env, "Edit", { agent_id: "a1", agent_type: "general-purpose" });
    expect(leesRecord(staat, "s1")?.tools_in_beurt).toBe(0);
    let a = leesRecord(staat, "a1");
    expect(a).toMatchObject({ soort: "subagent", ouder: "s1", agent_type: "general-purpose", toestand: "bezig", laatste_tool: "Edit", naam: "w2" });
    klok += 3000;
    await verwerk("SubagentStop", inv({ agent_id: "a1", agent_type: "general-purpose" }), env, opt);
    a = leesRecord(staat, "a1");
    expect(a).toMatchObject({ toestand: "klaar", einde: T0 + 3000 });
  });
});

describe("H6 gate (agent, sublead, vervolg)", () => {
  for (const rol of ["agent", "sublead", "vervolg"]) {
    test(`blokkeert bij ≥1 tool zonder rapport (${rol}); reden noemt de lead en de ene-zin-uitweg`, async () => {
      const env = omgeving({ LAB_AGENT_ROL: rol });
      await stuurTool(env);
      const u = await verwerk("Stop", inv({ stop_hook_active: false }), env, opt);
      const j = JSON.parse(u.stdout);
      expect(u.code).toBe(0);
      expect(j.decision).toBe("block");
      expect(j.reason).toContain("SendMessage(to: lead)");
      expect(j.reason).toContain("in één zin");
      expect(j.reason).toContain("waarop je wacht");
      expect(j.reason).toContain("Brian");
      expect(leesRecord(staat, "s1")?.blokkades).toBe(1);
    });
  }

  test("laat door zonder tools in de beurt", async () => {
    const env = omgeving();
    await verwerk("SessionStart", inv(), env, opt);
    expect((await verwerk("Stop", inv(), env, opt)).stdout).toBe("");
    expect(leesRecord(staat, "s1")?.toestand).toBe("idle");
  });

  test("laat door met stop_hook_active true", async () => {
    const env = omgeving();
    await stuurTool(env);
    expect((await verwerk("Stop", inv({ stop_hook_active: true }), env, opt)).stdout).toBe("");
    expect(leesRecord(staat, "s1")?.blokkades).toBe(0);
  });

  test("laat door na een SendMessage aan de lead: klaar; met vrij: vrij; inbox krijgt de toestand", async () => {
    const env = omgeving();
    await stuurTool(env);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "klaar" } }), env, opt);
    expect((await verwerk("Stop", inv(), env, opt)).stdout).toBe("");
    expect(leesRecord(staat, "s1")?.toestand).toBe("klaar");
    expect(inboxRegels().at(-1)?.tekst).toBe("w2 klaar (rapport binnen)");

    await stuurTool(env);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "vrij" } }), env, opt);
    await verwerk("Stop", inv(), env, opt);
    expect(leesRecord(staat, "s1")?.toestand).toBe("vrij");
  });

  test("rem: hoogstens 3 blokkades per sessie, daarna doorlaten met een inbox-regel", async () => {
    const env = omgeving();
    for (let i = 0; i < MAX_BLOKKADES; i++) {
      await stuurTool(env);
      expect(JSON.parse((await verwerk("Stop", inv({ stop_hook_active: false }), env, opt)).stdout).decision).toBe("block");
    }
    await stuurTool(env);
    const u = await verwerk("Stop", inv({ stop_hook_active: false }), env, opt);
    expect(u).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(inboxRegels().map((x) => x.tekst)).toContain("w2 stopte 3× zonder rapport");
    expect(leesRecord(staat, "s1")?.blokkades).toBe(3);
  });

  test("b) laat de stop door zolang subagents van deze sessie lopen; daarna weer blokkeren", async () => {
    const env = omgeving({ LAB_AGENT_ROL: "sublead" });
    await stuurTool(env);
    await verwerk("SubagentStart", inv({ agent_id: "a1", agent_type: "general-purpose" }), env, opt);
    expect((await verwerk("Stop", inv(), env, opt)).stdout).toBe("");
    expect(leesRecord(staat, "s1")?.blokkades).toBe(0);

    // een subagent van een andere sessie telt niet
    await verwerk("SubagentStop", inv({ agent_id: "a1" }), env, opt);
    await verwerk("SubagentStart", { session_id: "ander", agent_id: "a2", agent_type: "x", cwd: "/w" }, env, opt);
    await stuurTool(env);
    expect(JSON.parse((await verwerk("Stop", inv(), env, opt)).stdout).decision).toBe("block");

    // een subagent die al uren stil is, houdt de stop niet tegen
    await verwerk("SubagentStart", inv({ agent_id: "a3", agent_type: "x" }), env, opt);
    klok += 3 * 3600_000;
    await stuurTool(env);
    expect(JSON.parse((await verwerk("Stop", inv(), env, opt)).stdout).decision).toBe("block");
  });

  test("c) de beurtteller reset na een doorgelaten Stop, ook zonder UserPromptSubmit", async () => {
    const env = omgeving();
    await stuurTool(env);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "klaar" } }), env, opt);
    await verwerk("Stop", inv(), env, opt);
    // cross-session bericht wekt de sessie zonder UserPromptSubmit: nieuwe beurt zonder tools mag door
    expect(leesRecord(staat, "s1")?.tools_in_beurt).toBe(0);
    expect((await verwerk("Stop", inv(), env, opt)).stdout).toBe("");
    // en een nieuwe beurt met een tool zonder rapport wordt weer geblokkeerd
    await stuurTool(env);
    expect(JSON.parse((await verwerk("Stop", inv(), env, opt)).stdout).decision).toBe("block");
  });

  test("UserPromptSubmit zet de beurt op nul", async () => {
    const env = omgeving();
    await stuurTool(env);
    await verwerk("UserPromptSubmit", inv(), env, opt);
    expect((await verwerk("Stop", inv(), env, opt)).stdout).toBe("");
  });

  test("faalt open: een onleesbaar register of een staatmap die niet bestaat blokkeert niet", async () => {
    const env = omgeving({ LAB_LEAD_STAAT: "/dev/null/geen-map" });
    await stuurTool(env).catch(() => null);
    const u = await verwerk("Stop", inv(), env, opt).catch(() => null);
    // verwerk mag gooien (main vangt dat op en geeft exit 0); het mag nooit een block-uitvoer geven
    expect(u === null || u.stdout === "").toBe(true);
  });
});

describe("H2/H7 lead", () => {
  const lead = () => LEAD();

  test("H2 injecteert ongelezen regels als additionalContext en zet de offset vooruit", async () => {
    inboxMelding(staat, "lead", "w2", "w2 klaar (rapport binnen)", T0);
    inboxMelding(staat, "lead", "w3", "w3 wacht op goedkeuring (tool Bash)", T0);
    const u = await verwerk("UserPromptSubmit", inv(), lead(), opt);
    const j = JSON.parse(u.stdout);
    expect(j.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(j.hookSpecificOutput.additionalContext).toContain("Meldingen van je sessies: w2: w2 klaar");
    expect(j.hookSpecificOutput.additionalContext).toContain("w3: w3 wacht op goedkeuring");
    expect(gelezenOffset(staat, "lead")).toBe(statSync(inboxPad(staat, "lead")).size);
    expect((await verwerk("UserPromptSubmit", inv(), lead(), opt)).stdout).toBe("");
  });

  test("H2 en H7 lezen hoogstens 50 regels, de rest als +n meer", async () => {
    for (let i = 0; i < 53; i++) inboxMelding(staat, "lead", "w", `m${i}`, T0);
    const j = JSON.parse((await verwerk("UserPromptSubmit", inv(), lead(), opt)).stdout);
    expect(j.hookSpecificOutput.additionalContext).toContain("+3 meer");
    expect(j.hookSpecificOutput.additionalContext).not.toContain("m52");
  });

  test("d) H7 blokkeert alleen bij nieuwe regels en nooit twee keer voor dezelfde", async () => {
    inboxMelding(staat, "lead", "w2", "klaar", T0);
    const eerste = JSON.parse((await verwerk("Stop", inv({ stop_hook_active: false }), lead(), opt)).stdout);
    expect(eerste.decision).toBe("block");
    expect(eerste.reason).toContain("w2: klaar");
    // dezelfde regels: niet nog eens
    expect((await verwerk("Stop", inv({ stop_hook_active: false }), lead(), opt)).stdout).toBe("");
    // een nieuwe regel: wel weer
    inboxMelding(staat, "lead", "w3", "idle", T0);
    const tweede = JSON.parse((await verwerk("Stop", inv({ stop_hook_active: false }), lead(), opt)).stdout);
    expect(tweede.reason).toContain("w3: idle");
    expect(tweede.reason).not.toContain("w2: klaar");
  });

  test("d) regels die H2 al gaf, blokkeren H7 niet; stop_hook_active blokkeert nooit", async () => {
    inboxMelding(staat, "lead", "w2", "klaar", T0);
    await verwerk("UserPromptSubmit", inv(), lead(), opt);
    expect((await verwerk("Stop", inv({ stop_hook_active: false }), lead(), opt)).stdout).toBe("");
    inboxMelding(staat, "lead", "w3", "klaar", T0);
    expect((await verwerk("Stop", inv({ stop_hook_active: true }), lead(), opt)).stdout).toBe("");
    // de regel blijft ongelezen voor de volgende beurt
    expect(JSON.parse((await verwerk("UserPromptSubmit", inv(), lead(), opt)).stdout).hookSpecificOutput.additionalContext).toContain("w3");
  });

  test("de lead zelf krijgt geen gate en schrijft geen inbox-regels over zichzelf", async () => {
    await verwerk("PreToolUse", inv({ tool_name: "Bash" }), lead(), opt);
    expect((await verwerk("Stop", inv(), lead(), opt)).stdout).toBe("");
    expect(leesRecord(staat, "s1")?.toestand).toBe("idle");
    expect(existsSync(inboxPad(staat, "lead"))).toBe(false);
  });
});

describe("H11 wekker", () => {
  function nepKlok() {
    let t = 0;
    const slaap: number[] = [];
    return { nu: () => t, wacht: async (ms: number) => { slaap.push(ms); t += ms; }, slaap, tik: () => t };
  }

  test("wacht tot de inbox groeit, geeft de regels met exit 2 en markeert ze als gelezen", async () => {
    const k = nepKlok();
    let polls = 0;
    const wacht = async (ms: number) => {
      await k.wacht(ms);
      if (++polls === 3) inboxMelding(staat, "lead", "w2", "klaar", T0);
    };
    const u = await wekker(staat, "lead", k.nu, { wacht, wekkerInterval: 2000, wekkerMax: 60_000 });
    expect(u.code).toBe(2);
    expect(u.stderr).toContain("w2: klaar");
    expect(k.tik()).toBe(6000);
    expect(gelezenOffset(staat, "lead")).toBe(statSync(inboxPad(staat, "lead")).size);
    // dezelfde regels wekken niet nog eens
    const k2 = nepKlok();
    expect((await wekker(staat, "lead", k2.nu, { wacht: k2.wacht, wekkerInterval: 1000, wekkerMax: 3000 })).code).toBe(0);
  });

  test("geeft op na het maximum met exit 0 en zonder uitvoer", async () => {
    const k = nepKlok();
    const u = await wekker(staat, "lead", k.nu, { wacht: k.wacht, wekkerInterval: 2000, wekkerMax: 30 * 60_000 });
    expect(u).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(k.tik()).toBe(30 * 60_000);
    expect(k.slaap.every((m) => m === 2000)).toBe(true);
  });

  test("via verwerk: alleen voor rol lead", async () => {
    inboxMelding(staat, "lead", "w2", "klaar", T0);
    const k = nepKlok();
    const o = { nu, wacht: k.wacht, wekkerInterval: 1, wekkerMax: 1 };
    expect((await verwerk("wekker", {}, omgeving(), o)).code).toBe(0);
    expect((await verwerk("wekker", {}, LEAD(), o)).code).toBe(2);
  });
});

describe("privacy", () => {
  const GEHEIM = ["GEHEIM-PROMPT-91", "GEHEIM-TOOLINVOER-92", "GEHEIM-ANTWOORD-93", "GEHEIM-BERICHT-94", "GEHEIM-TRANSCRIPT-95", "GEHEIM-NOTIFICATIE-96"];

  function alleBestanden(map: string): string[] {
    const uit: string[] = [];
    for (const n of readdirSync(map, { withFileTypes: true })) {
      const p = join(map, n.name);
      if (n.isDirectory()) uit.push(...alleBestanden(p));
      else uit.push(p);
    }
    return uit;
  }

  test("na een volledige reeks events staat geen geheime string in de staatmap", async () => {
    const env = omgeving();
    const l = LEAD();
    const basis = { transcript_path: `/x/${GEHEIM[4]}.jsonl` };
    for (const e of [env, l]) {
      await verwerk("SessionStart", inv(basis), e, opt);
      await verwerk("UserPromptSubmit", inv({ ...basis, prompt: GEHEIM[0], user_message: GEHEIM[0] }), e, opt);
      await verwerk("PreToolUse", inv({ ...basis, tool_name: "Bash", tool_input: { command: GEHEIM[1] } }), e, opt);
      await verwerk("PreToolUse", inv({ ...basis, agent_id: "a1", agent_type: "x", tool_name: "Edit", tool_input: { file_path: GEHEIM[1] } }), e, opt);
      await verwerk("SubagentStart", inv({ ...basis, agent_id: "a1", agent_type: "x" }), e, opt);
      await verwerk("PostToolUse", inv({ ...basis, tool_name: "SendMessage", tool_input: { to: "lead", message: `${GEHEIM[3]} vrij`, summary: GEHEIM[3] }, tool_response: GEHEIM[1] }), e, opt);
      await verwerk("Notification", inv({ ...basis, notification_type: "permission_prompt", message: GEHEIM[5] }), e, opt);
      await verwerk("SubagentStop", inv({ ...basis, agent_id: "a1", agent_type: "x", last_assistant_message: GEHEIM[2], agent_transcript_path: `/x/${GEHEIM[4]}` }), e, opt);
      await verwerk("Stop", inv({ ...basis, stop_hook_active: false, last_assistant_message: GEHEIM[2] }), e, opt);
      await verwerk("Stop", inv({ ...basis, stop_hook_active: true, last_assistant_message: GEHEIM[2] }), e, opt);
      await verwerk("StopFailure", inv({ ...basis, error: GEHEIM[2], last_assistant_message: GEHEIM[2] }), e, opt);
      await verwerk("SessionEnd", inv(basis), e, opt);
    }
    const bestanden = alleBestanden(staat);
    expect(bestanden.length).toBeGreaterThan(3);
    for (const b of bestanden) {
      const inhoud = readFileSync(b, "utf8");
      for (const g of GEHEIM) expect(inhoud.includes(g)).toBe(false);
    }
    // wat er wel staat: het rapport is vastgelegd als boolean
    expect(leesRecord(staat, "s1")?.rapport_in_beurt).toBe(false);
  });

  test("inbox-regels blijven onder 512 bytes", () => {
    inboxMelding(staat, "lead", "w2", "ä".repeat(2000), T0);
    for (const r of readFileSync(inboxPad(staat, "lead"), "utf8").split("\n").filter(Boolean)) expect(Buffer.byteLength(r) + 1).toBeLessThan(512);
  });
});
