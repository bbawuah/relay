import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Opties, isVrijRegel, verwerk, wachtTot, wekker } from "./hook";
import { type Rec, gelezenOffset, inboxMelding, inboxPad, leesRecord, schrijfRecord } from "./register";

// Alles draait in een wegwerpmap (LAB_LEAD_STAAT); de echte ~/.claude en ~/.local/state blijven ongemoeid.

const HOOK_SH = join(import.meta.dir, "hook.sh");

test("sessieregistratie gebruikt rollen alleen als statusetiket", async () => {
  for (const rol of ["", "gast", "agent", "lead"]) {
    const id = `rol-${rol || "leeg"}`;
    await verwerk("SessionStart", inv({ session_id: id }), omgeving({ LAB_AGENT_ROL: rol }), opt);
    expect(leesRecord(staat, id)?.rol).toBe(rol);
    expect((await verwerk("Stop", inv({ session_id: id }), omgeving({ LAB_AGENT_ROL: rol }), opt)).stdout).toBe("");
  }
});
const T0 = 1_700_000_000_000;
const inCodexSandbox = process.env.CODEX_SANDBOX === "seatbelt";

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

  test("a) controle: met een rol wordt bun wel gestart (anders bewijst de test niets)", () => {
    const bin = nepBun();
    expect(draai({ PATH: `${bin}:/usr/bin:/bin`, LAB_AGENT_ROL: "agent" }).code).toBe(0);
    expect(existsSync(join(dir, "markeer"))).toBe(true);
  });

  test("LAB_LEAD_BUN wint van PATH als hij uitvoerbaar is", () => {
    const bin = nepBun();
    const eigen = join(dir, "eigen");
    writeFileSync(eigen, `#!/bin/sh\ntouch "${join(dir, "eigen-markeer")}"\n`);
    chmodSync(eigen, 0o755);
    expect(draai({ PATH: `${bin}:/usr/bin:/bin`, LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: eigen }).code).toBe(0);
    expect(existsSync(join(dir, "eigen-markeer"))).toBe(true);
    expect(existsSync(join(dir, "markeer"))).toBe(false);
  });

  test("LAB_LEAD_BUN wijst naar een verdwenen pad (brew upgrade): terugval op bun uit PATH", () => {
    const bin = nepBun();
    const weg = join(dir, "Cellar/bun/1.4.2/bin/bun");
    expect(draai({ PATH: `${bin}:/usr/bin:/bin`, LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: weg }).code).toBe(0);
    expect(existsSync(join(dir, "markeer"))).toBe(true);
  });

  test("LAB_LEAD_BUN verdwenen en geen bun in PATH: exit 0 zonder uitvoer", () => {
    const r = draai({ PATH: "/nergens", LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: join(dir, "bestaat-niet") });
    expect(r.code).toBe(0);
    expect(r.out + r.err).toBe("");
    expect(existsSync(join(dir, "markeer"))).toBe(false);
    expect(draai({ PATH: "/nergens", LAB_AGENT_ROL: "agent" }).code).toBe(0);
  });

  test("wekker zonder inbox-regels geeft na het maximum op met exit 0", () => {
    const env = { PATH: "/usr/bin:/bin", LAB_LEAD_BUN: process.execPath, LAB_LEAD_STAAT: staat, HOME: dir, LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: "lead", ARG: "wekker", LAB_WEKKER_INTERVAL_MS: "1", LAB_WEKKER_MAX_MS: "3" };
    expect(draai(env).code).toBe(0);
  });
});

describe("register (H1-H5, H8-H10)", () => {

  test("H1 SessionStart maakt een record met de vaste velden", async () => {
    await verwerk("SessionStart", inv(), omgeving({ TMUX_PANE: "%7" }), opt);
    const r = leesRecord(staat, "s1");
    expect(r).toEqual({
      id: "s1", soort: "sessie", naam: "w2", rol: "agent", lead: "lead", opdracht: "/x/OPDRACHT.md", cwd: "/w/w2", pane: "%7",
      toestand: "bezig", sinds: T0, start: T0, einde: null, laatste_tool: null, laatste_tool_om: null, tools_in_beurt: 0,
      rapport_om: null, rapport_in_beurt: false, vrij: false, blokkades: 0, ouder: null, agent_type: null,
      vendor: "claude", host: "tui", herkomst: "schoon",
    });
    expect(statSync(staat).mode & 0o077).toBe(0);
    expect(statSync(join(staat, "register", "s1.json")).mode & 0o077).toBe(0);
  });

  test("lead-proef registreert als Codex-lead met thread voor de queue-wekker", async () => {
    const env = omgeving({ LAB_AGENT_NAAM: "codex-lead", LAB_AGENT_ROL: "lead-proef", LAB_LEAD_NAAM: "codex-lead", CODEX_HOME: "/h/.codex-lead" });
    await verwerk("SessionStart", inv({ session_id: "codex-thread-1" }), env, { ...opt, bron: "codex" });
    expect(leesRecord(staat, "codex-thread-1")).toMatchObject({
      naam: "codex-lead",
      rol: "lead-proef",
      lead: "codex-lead",
      vendor: "codex",
      host: "tui",
      thread_id: "codex-thread-1",
      codex_home: "/h/.codex-lead",
    });
  });

  test("H1 zet vendor, naam en agent-markering op de eigen pane; H10 wist alleen de eigen sessie", async () => {
    const aanroepen: string[][] = [];
    const tmux = (args: string[]) => {
      aanroepen.push(args);
      return args.at(-1) === "@agent_sessie" ? "s1\n" : "";
    };
    const env = omgeving({ TMUX: "/wegwerp/socket,1,0", TMUX_PANE: "%7" });
    await verwerk("SessionStart", inv(), env, { ...opt, tmux });
    expect(aanroepen).toEqual([
      ["set-option", "-p", "-t", "%7", "@vendor", "claude"],
      ["set-option", "-p", "-t", "%7", "@agent", "claude"],
      ["set-option", "-p", "-t", "%7", "@agent_naam", "w2"],
      ["set-option", "-p", "-t", "%7", "@agent_sessie", "s1"],
    ]);
    aanroepen.length = 0;
    await verwerk("SessionEnd", inv(), env, { ...opt, tmux });
    expect(aanroepen).toEqual([
      ["show-options", "-p", "-t", "%7", "-v", "@agent_sessie"],
      ["set-option", "-p", "-t", "%7", "-u", "@vendor"],
      ["set-option", "-p", "-t", "%7", "-u", "@agent"],
      ["set-option", "-p", "-t", "%7", "-u", "@agent_naam"],
      ["set-option", "-p", "-t", "%7", "-u", "@agent_sessie"],
    ]);
  });

  // test-weg: scripts/lead/hooks/hook.test.ts: deze test start een wegwerp-tmux en slaat alleen de Codex-sandbox over; CI draait hem.
  test.skipIf(inCodexSandbox)("H1/H10 werken in een wegwerp-tmux, nooit op de standaardserver", async () => {
    const sok = `test-h-${process.pid}-${Date.now()}`;
    const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-L", sok, "-f", "/dev/null", ...args], { env: { ...process.env, TMUX: "", TMUX_PANE: "" } });
    try {
      expect(tmux("new-session", "-d", "-s", "h", "sleep 20").exitCode).toBe(0);
      const pane = tmux("list-panes", "-t", "h", "-F", "#{pane_id}").stdout.toString().trim();
      const pad = tmux("display-message", "-p", "-t", "h", "#{socket_path}").stdout.toString().trim();
      const env = omgeving({ TMUX: `${pad},0,0`, TMUX_PANE: pane });
      await verwerk("SessionStart", inv(), env, opt);
      expect(tmux("show-options", "-p", "-t", pane, "-v", "@vendor").stdout.toString().trim()).toBe("claude");
      expect(tmux("show-options", "-p", "-t", pane, "-v", "@agent_naam").stdout.toString().trim()).toBe("w2");
      await verwerk("SessionEnd", inv(), env, opt);
      expect(tmux("show-options", "-p", "-t", pane, "-v", "@vendor").exitCode).not.toBe(0);
    } finally {
      tmux("kill-server");
    }
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
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "PR 12 klaar, de slots waren vrij\n\nvrij" } }), env, opt);
    r = leesRecord(staat, "s1");
    expect(r?.vrij).toBe(true);
    // "vrijdag" is niet het woord vrij
    await verwerk("UserPromptSubmit", inv(), env, opt);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "vrijdag klaar" } }), env, opt);
    expect(leesRecord(staat, "s1")?.vrij).toBe(false);
  });

  test("fix: vrij alleen als vaste slotregel, niet als woord in de rapporttekst", async () => {
    const env = omgeving();
    for (const bericht of ["e2e-slots waren vrij", "vrij\nmaar nog bezig met e2e", "Ik ben vrij voor werk"]) {
      await verwerk("UserPromptSubmit", inv(), env, opt);
      await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: bericht } }), env, opt);
      expect([bericht, leesRecord(staat, "s1")?.vrij]).toEqual([bericht, false]);
    }
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "klaar\n\nVrij." } }), env, opt);
    expect(leesRecord(staat, "s1")?.vrij).toBe(true);
  });

  test("fix: wacht op achtergrondrun zet wacht_tot en zwijgt idle en 3×-melding tot dan", async () => {
    const env = omgeving();
    const vandaag = new Date(T0);
    vandaag.setHours(12, 0, 0, 0);
    klok = vandaag.getTime();
    await stuurTool(env);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "e2e loopt\nwacht op achtergrondrun tot ~12:30" } }), env, opt);
    expect(leesRecord(staat, "s1")?.wacht_tot).toBe(klok + 30 * 60_000);
    await verwerk("Stop", inv(), env, opt);
    const na = inboxRegels().length;
    for (let i = 0; i < 4; i++) {
      klok += 5 * 60_000;
      await stuurTool(env); // bezig, geen rapport in deze beurt
      const u = await verwerk("Stop", inv(), env, opt);
      expect(u.stdout).toBe(""); // ook geen gate-blokkade
    }
    expect(inboxRegels()).toHaveLength(na);
    // na ~12:30 is de wachttijd om en geldt de gate weer
    klok += 30 * 60_000;
    await stuurTool(env);
    expect((await verwerk("Stop", inv(), env, opt)).stdout).toBe("");
  });

  test("fix: wacht_tot hoogstens 2 uur vooruit; een verstreken of te ver weg liggende tijd telt niet", () => {
    const om = (u: number, m: number, dagen = 0) => {
      const d = new Date(T0);
      d.setDate(d.getDate() + dagen);
      d.setHours(u, m, 0, 0);
      return d.getTime();
    };
    const regel = (hhmm: string) => `klaar\nwacht op achtergrondrun tot ~${hhmm}`;
    expect(wachtTot(regel("12:30"), om(12, 0))).toBe(om(12, 30));
    expect(wachtTot(regel("14:00"), om(12, 0))).toBe(om(14, 0)); // precies 2 uur
    expect(wachtTot(regel("14:01"), om(12, 0))).toBeNull();
    expect(wachtTot(regel("23:59"), om(12, 0))).toBeNull(); // bijna een dag stilte
    expect(wachtTot(regel("12:30"), om(12, 31))).toBeNull(); // niet doorrollen naar morgen
    expect(wachtTot(regel("01:00"), om(23, 30))).toBe(om(1, 0, 1)); // over middernacht mag
    expect(wachtTot(regel("25:00"), om(12, 0))).toBeNull();
  });

  test("fix: vrij ook in opmaak (**vrij**, - vrij), maar niet midden in de tekst", () => {
    for (const ok of ["klaar\n**vrij**", "klaar\n- vrij", "klaar\n> Vrij.", "vrij\n\n"]) expect([ok, isVrijRegel(ok)]).toEqual([ok, true]);
    for (const nee of ["de slots waren vrij", "vrij\nmaar nog bezig", "vrijdag", "geen vrij"]) expect([nee, isVrijRegel(nee)]).toEqual([nee, false]);
  });

  test("fix: een sessie die idle was en zonder tools weer stopt, meldt niet opnieuw idle", async () => {
    const env = omgeving();
    await verwerk("SessionStart", inv(), env, opt);
    await verwerk("Stop", inv(), env, opt);
    const na = inboxRegels().filter((x) => x.tekst === "w2 is idle").length;
    for (let i = 0; i < 3; i++) await verwerk("Stop", inv(), env, opt);
    expect(inboxRegels().filter((x) => x.tekst === "w2 is idle")).toHaveLength(na);
  });

  test("fix: een melding wordt eenmaal afgeleverd, ook als twee lezers tegelijk komen", async () => {
    inboxMelding(staat, "lead", "w2", "w2 klaar (rapport binnen)", T0);
    inboxMelding(staat, "lead", "w2", "w2 klaar (rapport binnen)", T0);
    const lead = LEAD();
    // een andere lezer (wekker) houdt het slot vast terwijl de Stop-hook komt
    mkdirSync(join(staat, "inbox", "lead.gelezen.slot"), { recursive: true });
    const geblokkeerd = await verwerk("UserPromptSubmit", { session_id: "l1", cwd: "/w" }, { ...lead, LAB_AGENT_NAAM: "lead" }, opt);
    expect(geblokkeerd.stdout).toBe("");
    rmSync(join(staat, "inbox", "lead.gelezen.slot"), { recursive: true });
    const eerste = await verwerk("UserPromptSubmit", { session_id: "l1", cwd: "/w" }, { ...lead, LAB_AGENT_NAAM: "lead" }, opt);
    expect(eerste.stdout.match(/w2 klaar \(rapport binnen\)/g)).toHaveLength(1); // identieke regels vallen samen
    const tweede = await verwerk("UserPromptSubmit", { session_id: "l1", cwd: "/w" }, { ...lead, LAB_AGENT_NAAM: "lead" }, opt);
    expect(tweede.stdout).toBe("");
  });

  test("fix: een kindproces met hetzelfde LAB_SPAWN_ID registreert zich niet en meldt niets", async () => {
    const env = omgeving({ LAB_SPAWN_ID: "sp-1" });
    await verwerk("SessionStart", inv(), env, opt);
    await stuurTool(env);
    // `claude -p` erft de omgeving en heeft een eigen session_id
    const kind = (ev: string, extra: Record<string, unknown> = {}) => verwerk(ev, { session_id: "kind", cwd: "/w/kind", ...extra }, env, opt);
    await kind("SessionStart");
    await kind("PreToolUse", { tool_name: "Bash" });
    expect(await kind("Stop")).toEqual({ code: 0, stdout: "", stderr: "" }); // geen gate
    await kind("SessionEnd");
    expect(leesRecord(staat, "kind")).toBeNull();
    expect(leesRecord(staat, "s1")?.toestand).not.toBe("weg");
    expect(inboxRegels()).toHaveLength(0);
    // na SessionEnd van de eigenaar mag een volgende sessie (clear/resume) het id overnemen
    await verwerk("SessionEnd", inv(), env, opt);
    await kind("SessionStart");
    expect(leesRecord(staat, "kind")?.spawn_id).toBe("sp-1");
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

  }

  test("een sessie zonder lead (Regie: geen lead gekozen) wordt niet geblokkeerd en meldt niemand", async () => {
    const env = omgeving({ LAB_LEAD_NAAM: "" });
    await stuurTool(env);
    expect((await verwerk("Stop", inv({ stop_hook_active: false }), env, opt)).stdout).toBe("");
    expect(leesRecord(staat, "s1")?.blokkades).toBe(0);
    expect(inboxRegels("")).toHaveLength(0);
  });

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

  test("b2) geen idle-melding zolang eigen subagents lopen; klaar-meldingen blijven", async () => {
    const env = omgeving({ LAB_AGENT_ROL: "sublead" });
    await stuurTool(env);
    await verwerk("SubagentStart", inv({ agent_id: "a1", agent_type: "general-purpose" }), env, opt);
    await verwerk("Stop", inv(), env, opt);
    expect(leesRecord(staat, "s1")?.toestand).toBe("idle");
    expect(inboxRegels().map((x) => x.tekst)).not.toContain("w2 is idle");

    // rapport binnen: melding blijft, ook met een lopende subagent
    await stuurTool(env);
    await verwerk("PostToolUse", inv({ tool_name: "SendMessage", tool_input: { to: "lead", message: "klaar" } }), env, opt);
    await verwerk("Stop", inv(), env, opt);
    expect(inboxRegels().map((x) => x.tekst)).toContain("w2 klaar (rapport binnen)");

    // subagent klaar: gewone idle-melding komt weer
    await verwerk("SubagentStop", inv({ agent_id: "a1" }), env, opt);
    await verwerk("Stop", inv(), env, opt);
    expect(inboxRegels().map((x) => x.tekst)).toContain("w2 is idle");
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

  test("via verwerk: ieder roletiket kan alleen zijn eigen meldingen wekken", async () => {
    for (const [i, rol] of ["", "lead", "lead-proef", "agent", "sublead", "vervolg", "reviewer"].entries()) {
      const naam = `eigen-${i}`;
      inboxMelding(staat, naam, "w2", "klaar", T0);
      const k = nepKlok();
      const o = { nu, wacht: k.wacht, wekkerInterval: 1, wekkerMax: 1 };
      expect((await verwerk("wekker", {}, omgeving({ LAB_AGENT_NAAM: naam, LAB_AGENT_ROL: rol }), o)).code).toBe(2);
    }
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
    for (const e of [env, l]) {
      // aparte sessie per rol: het record houdt naam en lead van het eerste event vast
      const basis = { transcript_path: `/x/${GEHEIM[4]}.jsonl`, session_id: e === l ? "s2" : "s1" };
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

describe("leadnamen: het register is de bron, env alleen de beginwaarde", () => {
  // Beide leads en hun agents hebben dezelfde env-naam "lead"; de records hebben verschillende namen.
  const envLead = () => omgeving({ LAB_AGENT_NAAM: "lead", LAB_AGENT_ROL: "lead", LAB_LEAD_NAAM: "" });
  const envAgent = () => omgeving({ LAB_AGENT_NAAM: "w", LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "lead" });
  const sid = (id: string) => ({ session_id: id, cwd: "/w" });

  async function opzet() {
    for (const id of ["LA", "LB"]) await verwerk("SessionStart", sid(id), envLead(), { ...opt, panes: () => null });
    for (const id of ["WA", "WB"]) await verwerk("SessionStart", sid(id), envAgent(), opt);
    for (const [id, naam] of [["LA", "lead-a"], ["LB", "lead-b"]] as const) schrijfRecord(staat, { ...(leesRecord(staat, id) as Rec), naam });
    for (const [id, lead] of [["WA", "lead-a"], ["WB", "lead-b"]] as const) schrijfRecord(staat, { ...(leesRecord(staat, id) as Rec), lead });
  }

  test("een lead krijgt bij een verse start haar naam voor SendMessage en vraagt Brian om /rename; niet bij resume, clear of compact", async () => {
    const env = omgeving({ LAB_AGENT_NAAM: "lead-carriere", LAB_AGENT_ROL: "lead", LAB_LEAD_NAAM: "lead-carriere" });
    const u = await verwerk("SessionStart", { ...sid("LN"), source: "startup" }, env, { ...opt, panes: () => null });
    const txt = JSON.parse(u.stdout).hookSpecificOutput.additionalContext;
    expect(txt).toContain("lead-carriere");
    expect(txt).toContain("vraag Brian");
    expect(txt).toContain("/rename lead-carriere");
    for (const source of ["resume", "clear", "compact", undefined]) {
      const w = await verwerk("SessionStart", { ...sid("LN"), source }, env, { ...opt, panes: () => null });
      expect(w.stdout).toBe("");
    }
    // Zonder naam geen melding.
    const leeg = await verwerk("SessionStart", { ...sid("LX"), source: "startup" }, { ...env, LAB_AGENT_NAAM: "", LAB_LEAD_NAAM: "" }, { ...opt, panes: () => null });
    expect(leeg.stdout).not.toContain("SendMessage");
  });

  test("elke lead krijgt alleen de meldingen van haar eigen sessies (prompt en Stop)", async () => {
    await opzet();
    for (const id of ["WA", "WB"]) {
      await verwerk("PreToolUse", { ...sid(id), tool_name: "Bash" }, envAgent(), opt);
      await verwerk("Stop", sid(id), envAgent(), opt); // blokkeert; tweede stop meldt
      await verwerk("Stop", { ...sid(id), stop_hook_active: true }, envAgent(), opt);
    }
    expect(inboxRegels("lead")).toHaveLength(0);
    expect(inboxRegels("lead-a").length).toBeGreaterThan(0);
    expect(inboxRegels("lead-a").every((r) => r.van === "w")).toBe(true);
    const a = await verwerk("UserPromptSubmit", sid("LA"), envLead(), opt);
    expect(a.stdout).toContain("Meldingen van je sessies");
    expect(gelezenOffset(staat, "lead-a")).toBeGreaterThan(0);
    expect(gelezenOffset(staat, "lead-b")).toBe(0);
    const b = await verwerk("Stop", sid("LB"), envLead(), opt);
    expect(b.stdout).toBe("");
    expect(gelezenOffset(staat, "lead-b")).toBe(0);
    expect((await verwerk("UserPromptSubmit", sid("LB"), envLead(), opt)).stdout).toContain("Meldingen van je sessies");
  });

  test("de wekker wacht op de inbox van de recordnaam, niet op de env-naam", async () => {
    await opzet();
    inboxMelding(staat, "lead-a", "w", "klaar", T0);
    const eigen = await verwerk("wekker", sid("LA"), envLead(), { ...opt, wekkerMax: 0, wacht: async () => {} });
    expect(eigen.code).toBe(2);
    inboxMelding(staat, "lead", "w", "klaar", T0); // de env-naam: mag LB niet wekken
    const ander = await verwerk("wekker", sid("LB"), envLead(), { ...opt, wekkerMax: 0, wacht: async () => {} });
    expect(ander.code).toBe(0);
  });

  test("SessionStart bij resume behoudt naam en lead uit het record", async () => {
    await opzet();
    await verwerk("SessionStart", sid("LA"), envLead(), { ...opt, panes: () => null });
    await verwerk("SessionStart", sid("WA"), envAgent(), opt);
    expect(leesRecord(staat, "LA")?.naam).toBe("lead-a");
    expect(leesRecord(staat, "WA")?.lead).toBe("lead-a");
  });

  test("subagents melden aan de lead van hun ouder", async () => {
    await opzet();
    await verwerk("SubagentStart", { ...sid("WA"), agent_id: "x1" }, envAgent(), opt);
    expect(leesRecord(staat, "x1")?.lead).toBe("lead-a");
  });

  test("dubbele leadnaam bij SessionStart geeft een waarschuwing in de context; levend en weg onderscheiden", async () => {
    const o = { ...opt, panes: () => new Set(["%1", "%2"]) };
    const a = await verwerk("SessionStart", sid("LA"), { ...envLead(), TMUX_PANE: "%1" }, o);
    expect(a.stdout).not.toContain("WAARSCHUWING");
    const b = await verwerk("SessionStart", sid("LB"), { ...envLead(), TMUX_PANE: "%2" }, o);
    expect(b.stdout).toContain("WAARSCHUWING");
    expect(b.stdout).toContain("lead");
    expect(JSON.parse(b.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
    // eerste lead weg: geen waarschuwing meer
    await verwerk("SessionEnd", sid("LA"), envLead(), opt);
    expect((await verwerk("SessionStart", sid("LB"), { ...envLead(), TMUX_PANE: "%2" }, o)).stdout).not.toContain("WAARSCHUWING");
    // dode pane telt ook niet
    await verwerk("SessionStart", sid("LA"), { ...envLead(), TMUX_PANE: "%1" }, { ...opt, panes: () => new Set(["%2"]) });
    expect((await verwerk("SessionStart", sid("LB"), { ...envLead(), TMUX_PANE: "%2" }, { ...opt, panes: () => new Set(["%2"]) })).stdout).not.toContain("WAARSCHUWING");
  });

  test("/clear (nieuw session_id, zelfde pane): naam en lead van het voorgaande record blijven, rol moet gelijk zijn", async () => {
    await opzet();
    for (const [id, pane] of [["LA", "%5"], ["WA", "%6"]] as const) schrijfRecord(staat, { ...(leesRecord(staat, id) as Rec), pane, hernoemd: true });
    const o = { ...opt, panes: () => null };
    await verwerk("SessionStart", sid("LA2"), { ...envLead(), TMUX_PANE: "%5" }, o);
    await verwerk("SessionStart", sid("WA2"), { ...envAgent(), TMUX_PANE: "%6" }, o);
    expect(leesRecord(staat, "LA2")?.naam).toBe("lead-a");
    expect(leesRecord(staat, "WA2")?.lead).toBe("lead-a");
    // andere rol in dezelfde pane: geen overname
    await verwerk("SessionStart", sid("X1"), { ...envAgent(), TMUX_PANE: "%5" }, o);
    expect(leesRecord(staat, "X1")?.lead).toBe("lead");
  });

  test("/clear zonder hernoemd record: de env-naam geldt; na twee keer /clear blijft de nieuwe naam", async () => {
    await opzet();
    const o = { ...opt, panes: () => null };
    schrijfRecord(staat, { ...(leesRecord(staat, "LA") as Rec), pane: "%5" }); // niet hernoemd
    await verwerk("SessionStart", sid("LA2"), { ...envLead(), TMUX_PANE: "%5" }, o);
    expect(leesRecord(staat, "LA2")?.naam).toBe("lead");
    schrijfRecord(staat, { ...(leesRecord(staat, "LB") as Rec), pane: "%7", hernoemd: true });
    await verwerk("SessionStart", sid("LB2"), { ...envLead(), TMUX_PANE: "%7" }, o);
    klok += 1000;
    await verwerk("SessionStart", sid("LB3"), { ...envLead(), TMUX_PANE: "%7" }, o);
    expect(leesRecord(staat, "LB3")?.naam).toBe("lead-b");
  });
});

describe("Codex-subagent (fixture codex-UserPromptSubmit-subagent.json)", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "codex-fixtures", "codex-UserPromptSubmit-subagent.json"), "utf8")) as Record<string, unknown>;
  const codex: Opties = { nu, bron: "codex" };

  test("een UserPromptSubmit met agent_id (met het session_id van de hoofdsessie) telt niet als een nieuwe beurt van de hoofdsessie", async () => {
    const sid = String(fixture.session_id);
    const hoofd = { session_id: sid, cwd: "/w/w2" };
    await verwerk("SessionStart", { ...hoofd, source: "startup" }, omgeving(), codex);
    // de hoofdsessie is klaar met haar beurt: idle, rapport gedaan, drie tools
    const r = leesRecord(staat, sid) as Rec;
    schrijfRecord(staat, { ...r, toestand: "idle", sinds: T0, rapport_in_beurt: true, tools_in_beurt: 3, vrij: true, einde: T0 });
    klok = T0 + 5000;
    const u = await verwerk("UserPromptSubmit", fixture as Record<string, unknown>, omgeving(), codex);
    expect(u.stdout).toBe("");
    expect(leesRecord(staat, sid)).toMatchObject({ toestand: "idle", sinds: T0, rapport_in_beurt: true, tools_in_beurt: 3, vrij: true, einde: T0 });
    // zonder agent_id is het wel een nieuwe beurt
    const { agent_id: _a, agent_type: _t, ...gewoon } = fixture;
    await verwerk("UserPromptSubmit", gewoon, omgeving(), codex);
    expect(leesRecord(staat, sid)).toMatchObject({ toestand: "bezig", rapport_in_beurt: false, tools_in_beurt: 0 });
  });

});
