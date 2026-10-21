// Hooks H1-H11 van de lead-skill: één dispatch op het event.
//
// Gebruik (via hook.sh, dat bij lege LAB_AGENT_ROL meteen stopt):
//   hook.sh                  event uit `hook_event_name` op stdin (SessionStart, UserPromptSubmit,
//                            PreToolUse, PostToolUse, Notification, Stop, StopFailure,
//                            SubagentStart, SubagentStop, SessionEnd)
//   hook.sh wekker           H11, bedoeld voor een Stop-hook van de lead met `asyncRewake: true`:
//                            wacht tot de inbox nieuwe regels heeft (lokaal bestand, geen netwerk),
//                            geeft ze op stderr met exit 2, en geeft na een maximum op (exit 0).
//                            Instelbaar: LAB_WEKKER_INTERVAL_MS (standaard 2000) en
//                            LAB_WEKKER_MAX_MS (standaard 1800000 = 30 min).
//
// Omgeving (gezet door spawn.sh): LAB_AGENT_NAAM, LAB_AGENT_ROL (lead|agent|sublead|vervolg),
// LAB_LEAD_NAAM, LAB_OPDRACHT. Staat: ${LAB_LEAD_STAAT:-~/.local/state/lab-lead}.
//
// Alleen H6, H7 en H11 mogen blokkeren/wekken; alles faalt open (exit 0, geen uitvoer).
// Nooit opgeslagen: prompt, tool_input (behalve SendMessage.to en een boolean "vrij"),
// last_assistant_message, transcripts. Geen netwerk, geen git, geen gh.

import { type Omgeving, type Rec, dubbeleLeads, eigenLeadNaam, inboxGrootte, inboxMelding, leesOfMaak, leesRecord, lopendeSubagents, meldAdres, nieuwRecord, pakOngelezen, regelsTekst, schrijfRecord, staatMap, tmuxPanes, voorgangerInPane, zetToestand } from "./register";

export type Uitslag = { code: number; stdout: string; stderr: string };
export type Opties = {
  nu?: () => number;
  /** Alleen voor de wekker; injecteerbaar zodat tests niet op de echte klok wachten. */
  wacht?: (ms: number) => Promise<void>;
  wekkerInterval?: number;
  wekkerMax?: number;
  /** Pane-ids die tmux kent (null = onbekend); injecteerbaar voor tests. */
  panes?: () => Set<string> | null;
};

export const MAX_BLOKKADES = 3;
const ROLLEN = ["lead", "agent", "sublead", "vervolg"];
const LEEG: Uitslag = { code: 0, stdout: "", stderr: "" };

type Invoer = { [k: string]: unknown };
const tekst = (v: unknown): string => (typeof v === "string" ? v : "");

// Het register is de bron: env geeft alleen de beginwaarde (bij het eerste record).
function leadNaamVan(env: Omgeving, rec: Rec | null): string {
  return env.LAB_AGENT_ROL === "lead" ? eigenLeadNaam(rec, env) : meldAdres(rec, env);
}

/** "vrij" telt alleen als vaste slotregel: de laatste niet-lege regel is `vrij` (hoofdletters, punt of uitroepteken mogen). */
export function isVrijRegel(bericht: string): boolean {
  const regels = bericht.split("\n").map((x) => x.trim()).filter(Boolean);
  return /^vrij[.!]?$/i.test(regels.at(-1) ?? "");
}

/** Vaste slotregel `wacht op achtergrondrun tot ~HH:MM`: het eerstvolgende HH:MM na `t` (lokale tijd), anders null. */
export function wachtTot(bericht: string, t: number): number | null {
  const regels = bericht.split("\n").map((x) => x.trim()).filter(Boolean);
  const m = /^wacht op achtergrondrun tot ~?(\d{1,2}):(\d{2})\.?$/i.exec(regels.at(-1) ?? "");
  if (!m) return null;
  const [u, min] = [Number(m[1]), Number(m[2])];
  if (u > 23 || min > 59) return null;
  const d = new Date(t);
  d.setHours(u, min, 0, 0);
  if (d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function gateReden(lead: string): string {
  return (
    `Je stopt zonder rapport aan ${lead}. Stuur eerst SendMessage(to: ${lead}) met PR, sha, uitslag en open punten. ` +
    "Het is ook een geldig antwoord om in één zin te zeggen waarop je wacht (bijvoorbeeld een vraag aan Brian): " +
    `stuur die zin als SendMessage aan ${lead}, of zeg hem in je antwoord en stop dan opnieuw; de tweede stop wordt doorgelaten.`
  );
}

export async function verwerk(event: string, invoer: Invoer, env: Omgeving, opties: Opties = {}): Promise<Uitslag> {
  const rol = env.LAB_AGENT_ROL || "";
  if (!ROLLEN.includes(rol)) return LEEG;
  const nu = opties.nu ?? Date.now;
  const staat = staatMap(env);
  const sessieId = tekst(invoer.session_id);
  const rec0 = sessieId ? leesRecord(staat, sessieId) : null;
  if (event === "wekker") return rol === "lead" ? wekker(staat, leadNaamVan(env, rec0), nu, opties) : LEEG;
  if (!sessieId) return LEEG;
  const cwd = tekst(invoer.cwd) || process.cwd();
  const isLead = rol === "lead";
  const lead = leadNaamVan(env, rec0);
  const agentId = tekst(invoer.agent_id);
  const t = nu();

  const laad = (): Rec => leesOfMaak(staat, sessieId, env, cwd, t);
  const naamVan = (r: Rec) => r.naam || env.LAB_AGENT_NAAM || sessieId.slice(0, 8);
  const meld = (r: Rec, txt: string) => {
    if (!isLead && lead) inboxMelding(staat, lead, naamVan(r), txt, t);
  };

  switch (event) {
    case "SessionStart": {
      // H1
      const oud = laad();
      const vers = nieuwRecord(sessieId, env, cwd, t);
      // naam en lead uit het bestaande record (resume na hernoem.ts); env alleen de eerste keer
      const r: Rec = { ...vers, start: oud.start, blokkades: oud.blokkades, naam: rec0 ? oud.naam : vers.naam, lead: rec0 ? oud.lead : vers.lead };
      if (!rec0) {
        const vg = voorgangerInPane(staat, vers.pane, isLead, sessieId, t);
        if (vg) {
          r.naam = vg.naam || r.naam;
          r.lead = vg.lead || r.lead;
          r.hernoemd = true;
        }
      }
      schrijfRecord(staat, r);
      if (isLead) {
        const dubbel = dubbeleLeads(staat, r.naam, r.id, (opties.panes ?? tmuxPanes)());
        // Het register kent de naam, Claude Code pas na `-n` of `/rename`. Een model kan geen /rename uitvoeren: de lead
        // moet Brian vragen het te typen. Alleen bij een verse start (niet resume, clear of compact) en met een naam.
        let txt = "";
        if (r.naam && tekst(invoer.source) === "startup") {
          txt = `Je naam voor SendMessage is ${r.naam}. Staat je sessie in ListAgents onder een andere naam (bijvoorbeeld lab-bawuah-33), dan komen berichten aan ${r.naam} niet aan ("not reachable"). Een model kan /rename niet uitvoeren: vraag Brian om \`/rename ${r.naam}\` te typen. De echte oplossing is de lead-functie met -n.`;
        }
        if (dubbel.length > 0) {
          const waar = dubbel.map((d) => `sessie ${d.id.slice(0, 8)}${d.pane ? ` (pane ${d.pane})` : ""}`).join(", ");
          txt =
            `WAARSCHUWING: er draait al een lead met de naam ${r.naam}: ${waar}. Jullie krijgen elkaars meldingen niet apart. ` +
            `Geef een van beiden een unieke naam: bun scripts/lead/hernoem.ts --sessie <id> --naam lead-<onderwerp> [--volgers a,b], en /rename voor SendMessage.`;
        }
        if (txt) return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: txt } }), stderr: "" };
      }
      return LEEG;
    }
    case "UserPromptSubmit": {
      // H2
      const r = laad();
      zetToestand(r, "bezig", t);
      r.tools_in_beurt = 0;
      r.rapport_in_beurt = false;
      r.vrij = false;
      r.einde = null;
      schrijfRecord(staat, r);
      if (isLead) {
        const o = pakOngelezen(staat, lead, t);
        if (o.regels.length > 0) {
          const uit = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `Meldingen van je sessies: ${regelsTekst(o)}` } };
          return { code: 0, stdout: JSON.stringify(uit), stderr: "" };
        }
      }
      return LEEG;
    }
    case "PreToolUse": {
      // H3
      const tool = tekst(invoer.tool_name) || null;
      if (agentId) {
        const a = leesSub(staat, agentId, sessieId, env, invoer, t, rec0);
        a.laatste_tool = tool;
        a.laatste_tool_om = t;
        zetToestand(a, "bezig", t);
        schrijfRecord(staat, a);
        return LEEG;
      }
      const r = laad();
      if (r.tools_in_beurt === 0) {
        r.vrij = false;
        r.rapport_in_beurt = false;
      }
      r.tools_in_beurt += 1;
      r.laatste_tool = tool;
      r.laatste_tool_om = t;
      r.einde = null;
      zetToestand(r, "bezig", t);
      schrijfRecord(staat, r);
      return LEEG;
    }
    case "PostToolUse": {
      // H4: alleen SendMessage aan de eigen lead; niets van de tekst zelf, alleen of "vrij" erin staat.
      if (agentId || isLead || tekst(invoer.tool_name) !== "SendMessage") return LEEG;
      const inv = (invoer.tool_input && typeof invoer.tool_input === "object" ? invoer.tool_input : {}) as Invoer;
      if (!lead || tekst(inv.to) !== lead) return LEEG;
      const r = laad();
      r.rapport_om = t;
      r.rapport_in_beurt = true;
      const bericht = tekst(inv.message);
      if (isVrijRegel(bericht)) r.vrij = true;
      r.wacht_tot = wachtTot(bericht, t);
      schrijfRecord(staat, r);
      return LEEG;
    }
    case "Notification": {
      // H5
      const soort = tekst(invoer.notification_type) || (/permission/i.test(tekst(invoer.message)) ? "permission_prompt" : "");
      if (soort !== "permission_prompt" && soort !== "idle_prompt") return LEEG;
      const r = laad();
      if (soort === "permission_prompt") {
        zetToestand(r, "goedkeuring", t);
        meld(r, `${naamVan(r)} wacht op goedkeuring (tool ${r.laatste_tool ?? "?"})`);
      } else {
        zetToestand(r, "idle", t);
      }
      schrijfRecord(staat, r);
      return LEEG;
    }
    case "Stop":
      return stop(staat, laad(), invoer, isLead, lead, naamVan, t);
    case "StopFailure": {
      // H8
      const r = laad();
      zetToestand(r, "vastgelopen", t);
      schrijfRecord(staat, r);
      meld(r, `${naamVan(r)} is vastgelopen (API-fout)`);
      return LEEG;
    }
    case "SubagentStart": {
      // H9
      if (!agentId) return LEEG;
      const a = leesSub(staat, agentId, sessieId, env, invoer, t, rec0);
      a.start = t;
      a.einde = null;
      zetToestand(a, "bezig", t);
      schrijfRecord(staat, a);
      return LEEG;
    }
    case "SubagentStop": {
      if (!agentId) return LEEG;
      const a = leesSub(staat, agentId, sessieId, env, invoer, t, rec0);
      zetToestand(a, "klaar", t);
      a.einde = t;
      schrijfRecord(staat, a);
      return LEEG;
    }
    case "SessionEnd": {
      // H10: één write
      const r = laad();
      zetToestand(r, "weg", t);
      r.einde = t;
      schrijfRecord(staat, r);
      return LEEG;
    }
    default:
      return LEEG;
  }
}

function leesSub(staat: string, agentId: string, ouder: string, env: Omgeving, invoer: Invoer, t: number, ouderRec: Rec | null): Rec {
  const basis = nieuwRecord(agentId, env, tekst(invoer.cwd) || process.cwd(), t);
  const oud = leesOfMaak(staat, agentId, env, basis.cwd, t);
  return { ...oud, soort: "subagent", rol: "subagent", ouder, agent_type: tekst(invoer.agent_type) || oud.agent_type, naam: env.LAB_AGENT_NAAM || oud.naam, lead: ouderRec?.lead || oud.lead };
}

function stop(staat: string, r: Rec, invoer: Invoer, isLead: boolean, lead: string, naamVan: (r: Rec) => string, t: number): Uitslag {
  const actief = invoer.stop_hook_active === true;

  if (isLead) {
    // H7: alleen regels die nieuw zijn sinds de laatste keer dat de lead ze zag (H2, H7 of H11).
    if (!actief) {
      const o = pakOngelezen(staat, lead, t);
      if (o.regels.length > 0) {
        const reden = `Nieuwe meldingen van je sessies: ${regelsTekst(o)}. Verwerk ze voordat je stopt.`;
        return { code: 0, stdout: JSON.stringify({ decision: "block", reason: reden }), stderr: "" };
      }
    }
    zetToestand(r, "idle", t);
    r.tools_in_beurt = 0;
    r.rapport_in_beurt = false;
    schrijfRecord(staat, r);
    return LEEG;
  }

  // H6: gate voor agent, sublead en vervolg.
  const naam = naamVan(r);
  const wachtOpSubagents = lopendeSubagents(staat, r.id, t).length > 0;
  const wachtOpRun = (r.wacht_tot ?? 0) > t;
  const wilBlokkeren = lead !== "" && !actief && r.tools_in_beurt >= 1 && !r.rapport_in_beurt && !wachtOpSubagents && !wachtOpRun;
  let stopte3 = false;
  if (wilBlokkeren) {
    if (r.blokkades < MAX_BLOKKADES) {
      r.blokkades += 1;
      schrijfRecord(staat, r);
      return { code: 0, stdout: JSON.stringify({ decision: "block", reason: gateReden(lead) }), stderr: "" };
    }
    inboxMelding(staat, lead, naam, `${naam} stopte ${MAX_BLOKKADES}× zonder rapport`, t);
    stopte3 = true;
    r.blokkades = 0; // de volgende reeks begint opnieuw; anders komt de melding bij elke Stop terug
  }
  const toestand = r.rapport_in_beurt ? (r.vrij ? "vrij" : "klaar") : "idle";
  // Idle is alleen nieuws bij een overgang: een sessie die idle was en zonder tools weer stopt, meldt niets.
  const herhaaldIdle = toestand === "idle" && r.toestand === "idle" && r.tools_in_beurt === 0;
  zetToestand(r, toestand, t);
  r.tools_in_beurt = 0;
  r.rapport_in_beurt = false;
  schrijfRecord(staat, r);
  // Idle omdat de sessie op eigen lopende subagents wacht is ruis voor de lead; het register toont het wel.
  const zwijg = toestand === "idle" && (wachtOpSubagents || wachtOpRun || stopte3 || herhaaldIdle);
  if (lead && !zwijg) inboxMelding(staat, lead, naam, toestand === "vrij" ? `${naam} klaar en vrij` : toestand === "klaar" ? `${naam} klaar (rapport binnen)` : `${naam} is idle`, t);
  return LEEG;
}

/** H11: wacht tot de inbox nieuwe regels heeft; exit 2 met de regels op stderr. Geeft op na het maximum. */
export async function wekker(staat: string, lead: string, nu: () => number, opties: Opties): Promise<Uitslag> {
  const interval = opties.wekkerInterval ?? 2000;
  const max = opties.wekkerMax ?? 30 * 60_000;
  const wacht = opties.wacht ?? ((ms: number) => new Promise<void>((klaar) => setTimeout(klaar, ms)));
  const begin = nu();
  for (;;) {
    if (inboxGrootte(staat, lead) > 0) {
      const o = pakOngelezen(staat, lead, nu());
      if (o.regels.length > 0) {
        return { code: 2, stdout: "", stderr: `Meldingen van je sessies: ${regelsTekst(o)}` };
      }
    }
    if (nu() - begin >= max) return LEEG;
    await wacht(interval);
  }
}

function getalEnv(v: string | undefined): number | undefined {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function main(): Promise<void> {
  process.umask(0o077);
  try {
    const arg = process.argv[2] || "";
    let invoer: Invoer = {};
    try {
      const ruw = await Bun.stdin.text();
      const j = ruw.trim() ? JSON.parse(ruw) : {};
      if (j && typeof j === "object") invoer = j as Invoer;
    } catch {
      // kapotte stdin: lege invoer
    }
    const event = arg || tekst(invoer.hook_event_name);
    const u = await verwerk(event, invoer, process.env, {
      wekkerInterval: getalEnv(process.env.LAB_WEKKER_INTERVAL_MS),
      wekkerMax: getalEnv(process.env.LAB_WEKKER_MAX_MS),
    });
    if (u.stdout) process.stdout.write(u.stdout);
    if (u.code === 2) {
      if (u.stderr) process.stderr.write(u.stderr);
      process.exit(2);
    }
  } catch {
    // faalt open
  }
  process.exit(0);
}

if (import.meta.main) await main();

