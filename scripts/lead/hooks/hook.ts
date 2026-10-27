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
// Codex: hook.sh --bron codex <event>; de invoer is bijna gelijk (codex-adapter.ts). Het record krijgt vendor, host,
// thread_id en codex_home (Codex) of socket (Claude), en herkomst (`extern` na WebFetch/WebSearch/MCP buiten peers).
//
// Peerbus: UserPromptSubmit geeft het seintje (aantal ongelezen peer-berichten, nooit de inhoud), Stop blokt één keer met het
// seintje en Stop/SessionEnd melden de toestand aan de bus (idleGemeld). De bus wordt dynamisch geladen (laadPeers) en
// ontbreekt hij, dan doen de hooks alleen het werk hierboven.
//
// Alleen H6, H7 en H11 mogen blokkeren/wekken; alles faalt open (exit 0, geen uitvoer).
// Nooit opgeslagen: prompt, tool_input (behalve SendMessage.to en een boolean "vrij"),
// last_assistant_message, transcripts. Geen netwerk, geen git, geen gh.

import type { Bus } from "../peers/types";
import { type Bron, PEERS_SEND, herkomstNa, leesBron, peerVelden, sendAfgeleverd } from "./codex-adapter";
import { type Omgeving, type Rec, type Toestand, dubbeleLeads, eigenLeadNaam, inboxGrootte, inboxMelding, leesOfMaak, leesRecord, lopendeSubagents, isKindProces, meldAdres, nieuwRecord, pakOngelezen, regelsTekst, schrijfRecord, staatMap, tmuxPanes, voorgangerInPane, ververseIdentiteit, wisExternMarkering, wisIdentiteit, zetToestand } from "./register";

export type Uitslag = { code: number; stdout: string; stderr: string };
export type Opties = {
  nu?: () => number;
  /** Alleen voor de wekker; injecteerbaar zodat tests niet op de echte klok wachten. */
  wacht?: (ms: number) => Promise<void>;
  wekkerInterval?: number;
  wekkerMax?: number;
  /** Pane-ids die tmux kent (null = onbekend); injecteerbaar voor tests. */
  panes?: () => Set<string> | null;
  /** Wie de hook aanroept; bepaalt vendor, thread_id en socket in het record. Standaard claude. */
  bron?: Bron;
  /** De peerbus (seintje en idleGemeld); standaard de bus op de staatmap. Tests geven een nep-bus mee. */
  bus?: Bus | null;
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

/** Laatste niet-lege regel zonder opmaaktekens aan de randen (`**vrij**`, `- vrij`, `> vrij.`). */
function slotRegel(bericht: string): string {
  const regel = bericht.split("\n").map((x) => x.trim()).filter(Boolean).at(-1) ?? "";
  return regel.replace(/^[\s>*_`-]+/, "").replace(/[\s*_`]+$/, "");
}

/** "vrij" telt alleen als vaste slotregel: de laatste niet-lege regel is `vrij` (hoofdletters, opmaak, punt of uitroepteken mogen). */
export function isVrijRegel(bericht: string): boolean {
  return /^vrij[.!]?$/i.test(slotRegel(bericht));
}

export const WACHT_MAX_MS = 2 * 3600_000;

/**
 * Vaste slotregel `wacht op achtergrondrun tot ~HH:MM`: het moment (vandaag of morgen, lokale tijd) dat 0 tot 2 uur na `t`
 * ligt. Een tijd die al voorbij is (12:30 om 12:31) of verder dan 2 uur weg (23:59 om 12:00) telt niet: null, dus normaal melden.
 */
export function wachtTot(bericht: string, t: number): number | null {
  const m = /^wacht op achtergrondrun tot ~?(\d{1,2}):(\d{2})\.?$/i.exec(slotRegel(bericht));
  if (!m) return null;
  const [u, min] = [Number(m[1]), Number(m[2])];
  if (u > 23 || min > 59) return null;
  for (const dag of [0, 1]) {
    const d = new Date(t);
    d.setDate(d.getDate() + dag);
    d.setHours(u, min, 0, 0);
    const verschil = d.getTime() - t;
    if (verschil > 0 && verschil <= WACHT_MAX_MS) return d.getTime();
  }
  return null;
}

export function gateReden(lead: string, bron: Bron = "claude"): string {
  const stuur = bron === "codex" ? `mcp__peers__send(naar: ${lead}, tekst: …)` : `SendMessage(to: ${lead})`;
  return (
    `Je stopt zonder rapport aan ${lead}. Stuur eerst ${stuur} met PR, sha, uitslag en open punten. ` +
    "Het is ook een geldig antwoord om in één zin te zeggen waarop je wacht (bijvoorbeeld een vraag aan Brian): " +
    `stuur die zin met ${bron === "codex" ? "mcp__peers__send" : "SendMessage"} aan ${lead}, of zeg hem in je antwoord en stop dan opnieuw; de tweede stop wordt doorgelaten.`
  );
}

type Peers = { bus: Bus; seintje: (aantal: number) => string };

/**
 * De peerbus voor deze staatmap, met het seintje uit het contract (types.ts). In de geïnstalleerde map ligt hij op ./peers
 * (installeer-hooks.ts kopieert hem erheen), in de repo op ../peers. ./peers gaat voor: een vreemde `peers`-map naast de
 * installatiemap (../peers) wint dus nooit van de eigen kopie. Dynamisch geladen: ontbreekt hij of faalt het laden,
 * dan is er geen bus en doen de hooks alleen het oude werk (faalt open).
 */
async function laadPeers(env: Omgeving, opties: Opties): Promise<Peers | null> {
  for (const map of ["./peers", "../peers"]) {
    try {
      const t = (await import(`${map}/types`)) as { seintje: (n: number) => string };
      if (opties.bus !== undefined) return opties.bus ? { bus: opties.bus, seintje: t.seintje } : null;
      const m = (await import(`${map}/standaard`)) as { standaardBus: (e: Omgeving) => Bus };
      return { bus: m.standaardBus(env), seintje: t.seintje };
    } catch {
      // volgende pad
    }
  }
  return null;
}

/** Ongelezen peer-berichten van `naam`. Telt alleen (list verandert niets, anders dan inbox, dat extern kan markeren). */
function ongelezen(bus: Bus | null, naam: string): number {
  if (!bus || !naam) return 0;
  try {
    return bus.list().find((p) => p.naam === naam)?.ongelezen ?? 0;
  } catch {
    return 0;
  }
}

/** Lever openstaande idle-abonnementen af. De bus wacht zelf op zijn wekker; een fout hier mag de hook niet breken. */
async function idleGemeld(bus: Bus | null, naam: string, toestand: Toestand): Promise<void> {
  if (!bus || !naam) return;
  try {
    await bus.idleGemeld(naam, toestand);
  } catch {
    // faalt open
  }
}

export async function verwerk(event: string, invoer: Invoer, env: Omgeving, opties: Opties = {}): Promise<Uitslag> {
  const rol = env.LAB_AGENT_ROL || "";
  if (!ROLLEN.includes(rol)) return LEEG;
  const nu = opties.nu ?? Date.now;
  const staat = staatMap(env);
  // Een kindproces (bijvoorbeeld `claude -p`) erft de omgeving van een geregistreerde sessie maar is geen sessie.
  if (event !== "wekker" && isKindProces(staat, env.LAB_SPAWN_ID || "", tekst(invoer.session_id), nu())) return LEEG;
  const sessieId = tekst(invoer.session_id);
  const rec0 = sessieId ? leesRecord(staat, sessieId) : null;
  if (event === "wekker") return rol === "lead" ? wekker(staat, leadNaamVan(env, rec0), nu, opties) : LEEG;
  if (!sessieId) return LEEG;
  const cwd = tekst(invoer.cwd) || process.cwd();
  const isLead = rol === "lead";
  const lead = leadNaamVan(env, rec0);
  const agentId = tekst(invoer.agent_id);
  const t = nu();

  const bron = opties.bron ?? "claude";
  const peers = event === "UserPromptSubmit" || event === "Stop" || event === "SessionEnd" ? await laadPeers(env, opties) : null;
  const bus = peers?.bus ?? null;
  const laad = (): Rec => {
    const r = leesOfMaak(staat, sessieId, env, cwd, t);
    const m = r.vendor ? r : { ...r, ...peerVelden(bron, env, sessieId) };
    // spawn.sh --t3 kent het thread-id pas na de start van de thread: de identiteit krijgt het erbij, dus het volgende event vult het aan.
    return env.LAB_T3_THREAD && m.t3_thread !== env.LAB_T3_THREAD ? { ...m, host: "t3" as const, t3_thread: env.LAB_T3_THREAD } : m;
  };
  const naamVan = (r: Rec) => r.naam || env.LAB_AGENT_NAAM || sessieId.slice(0, 8);
  const meld = (r: Rec, txt: string) => {
    if (!isLead && lead) inboxMelding(staat, lead, naamVan(r), txt, t);
  };

  switch (event) {
    case "SessionStart": {
      // H1
      const oud = laad();
      // De bus markeert een sessie die externe inhoud las met <staat>/peers/extern/<naam>. Alleen een verse start of /clear is weer
      // schoon; bij resume (en compact) staat de oude context er nog en blijft de herkomst `extern`.
      const bronStart = tekst(invoer.source);
      const schoon = bronStart === "startup" || bronStart === "clear" || bronStart === "";
      const vers = nieuwRecord(sessieId, env, cwd, t);
      // naam en lead uit het bestaande record (resume na hernoem.ts); env alleen de eerste keer
      // Peer-velden worden bij elke start ververst (een socket of thread kan veranderen); `inbound` is een keuze van Brian en blijft.
      const velden = peerVelden(bron, env, sessieId);
      const r: Rec = { ...vers, ...velden, ...(schoon ? {} : { herkomst: oud.herkomst ?? velden.herkomst }), ...(oud.inbound ? { inbound: oud.inbound } : {}), start: oud.start, blokkades: oud.blokkades, naam: rec0 ? oud.naam : vers.naam, lead: rec0 ? oud.lead : vers.lead };
      if (!rec0) {
        const vg = voorgangerInPane(staat, vers.pane, isLead, sessieId, t);
        if (vg) {
          r.naam = vg.naam || r.naam;
          r.lead = vg.lead || r.lead;
          r.hernoemd = true;
        }
      }
      schrijfRecord(staat, r);
      if (schoon) wisExternMarkering(staat, r.naam);
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
      ververseIdentiteit(staat, cwd, env.LAB_SPAWN_ID || "", t);
      const r = laad();
      zetToestand(r, "bezig", t);
      r.tools_in_beurt = 0;
      r.rapport_in_beurt = false;
      r.vrij = false;
      r.einde = null;
      schrijfRecord(staat, r);
      const delen: string[] = [];
      if (isLead) {
        const o = pakOngelezen(staat, lead, t);
        if (o.regels.length > 0) delen.push(`Meldingen van je sessies: ${regelsTekst(o)}`);
      }
      // Peerbus: alleen het aantal (seintje), nooit de inhoud; die haalt het model zelf op met de tool inbox.
      const n = ongelezen(bus, naamVan(r));
      if (n > 0 && peers) delen.push(peers.seintje(n));
      if (delen.length === 0) return LEEG;
      return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delen.join("\n") } }), stderr: "" };
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
      if (agentId) return LEEG;
      const tool = tekst(invoer.tool_name);
      // Herkomst: na externe inhoud (WebFetch, WebSearch, een MCP-tool buiten `peers`) blijft de sessie `extern` tot SessionStart.
      const extern = herkomstNa(tool, undefined) === "extern";
      // H4: een bericht aan de eigen lead: SendMessage (to) of peers.send (naar); niets van de tekst zelf, alleen of "vrij" erin staat.
      const inv = (invoer.tool_input && typeof invoer.tool_input === "object" ? invoer.tool_input : {}) as Invoer;
      // Een peers.send telt alleen als hij gelukt is (een geweigerde of vastgehouden send is geen rapport); SendMessage meldt geen mislukking aan de hook.
      const aanLead = !isLead && !!lead && (tool === "SendMessage" ? tekst(inv.to) === lead : tool === PEERS_SEND && tekst(inv.naar) === lead && sendAfgeleverd(invoer.tool_response));
      if (!extern && !aanLead) return LEEG;
      const r = laad();
      if (extern) r.herkomst = "extern";
      if (aanLead) {
        r.rapport_om = t;
        r.rapport_in_beurt = true;
        const bericht = tekst(tool === "SendMessage" ? inv.message : inv.tekst);
        if (isVrijRegel(bericht)) r.vrij = true;
        r.wacht_tot = wachtTot(bericht, t);
      }
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
      ververseIdentiteit(staat, cwd, env.LAB_SPAWN_ID || "", t);
      return stop(staat, laad(), invoer, isLead, lead, naamVan, t, peers, bron);
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
      // De identiteit van deze spawn (codex-wrap) is niet meer nodig; een nieuwe spawn in dezelfde checkout blijft staan.
      wisIdentiteit(staat, cwd, env.LAB_SPAWN_ID || "", t);
      await idleGemeld(bus, naamVan(r), "weg");
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

async function stop(staat: string, r: Rec, invoer: Invoer, isLead: boolean, lead: string, naamVan: (r: Rec) => string, t: number, peers: Peers | null, bron: Bron): Promise<Uitslag> {
  const bus = peers?.bus ?? null;
  const actief = invoer.stop_hook_active === true;
  // Peerbus: één keer blokkeren met het seintje (nooit de inhoud); de tweede stop (stop_hook_active) gaat door.
  const n = actief ? 0 : ongelezen(bus, naamVan(r));
  const seintjeTekst = n > 0 && peers ? ` ${peers.seintje(n)}` : "";

  if (isLead) {
    // H7: alleen regels die nieuw zijn sinds de laatste keer dat de lead ze zag (H2, H7 of H11).
    if (!actief) {
      const o = pakOngelezen(staat, lead, t);
      if (o.regels.length > 0) {
        const reden = `Nieuwe meldingen van je sessies: ${regelsTekst(o)}. Verwerk ze voordat je stopt.${seintjeTekst}`;
        return { code: 0, stdout: JSON.stringify({ decision: "block", reason: reden }), stderr: "" };
      }
      if (n > 0) return { code: 0, stdout: JSON.stringify({ decision: "block", reason: seintjeTekst.trim() }), stderr: "" };
    }
    zetToestand(r, "idle", t);
    r.tools_in_beurt = 0;
    r.rapport_in_beurt = false;
    schrijfRecord(staat, r);
    await idleGemeld(bus, naamVan(r), "idle");
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
      return { code: 0, stdout: JSON.stringify({ decision: "block", reason: `${gateReden(lead, bron)}${seintjeTekst}` }), stderr: "" };
    }
    inboxMelding(staat, lead, naam, `${naam} stopte ${MAX_BLOKKADES}× zonder rapport`, t);
    stopte3 = true;
    r.blokkades = 0; // de volgende reeks begint opnieuw; anders komt de melding bij elke Stop terug
  }
  // Geen gate, wel ongelezen peer-berichten: één keer blokkeren met alleen het seintje.
  if (!wilBlokkeren && n > 0) return { code: 0, stdout: JSON.stringify({ decision: "block", reason: seintjeTekst.trim() }), stderr: "" };
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
  await idleGemeld(bus, naam, toestand);
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
    const { bron, rest } = leesBron(process.argv.slice(2));
    const arg = rest[0] || "";
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
      bron,
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

