// Register en inbox van de lead-hooks (staatmap, atomair schrijven, privacy).
// Geen netwerk, geen git. Alleen bestanden onder de staatmap.
//
// Staatmap: ${LAB_LEAD_STAAT:-$HOME/.local/state/lab-lead}
//   register/<id>.json     een record per sessie of subagent (tmp + rename)
//   inbox/<lead>.jsonl     meldingen voor die lead, één regel < 512 B per append
//   inbox/<lead>.gelezen   byte-offset tot waar de lead de inbox gezien heeft
//
// Er worden nooit prompttekst, tool-invoer, antwoorden of transcripts bewaard.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Toestand = "bezig" | "idle" | "goedkeuring" | "klaar" | "vrij" | "vastgelopen" | "weg";

export type Rec = {
  id: string;
  soort: "sessie" | "subagent";
  naam: string;
  rol: string;
  lead: string;
  opdracht: string;
  cwd: string;
  pane: string;
  toestand: Toestand;
  sinds: number;
  start: number;
  einde: number | null;
  laatste_tool: string | null;
  laatste_tool_om: number | null;
  tools_in_beurt: number;
  rapport_om: number | null;
  rapport_in_beurt: boolean;
  vrij: boolean;
  blokkades: number;
  ouder: string | null;
  agent_type: string | null;
};

export type Omgeving = { [k: string]: string | undefined };

export const MAX_INBOX_REGELS = 50;
export const MAX_REGEL_BYTES = 511;

export function staatMap(env: Omgeving): string {
  return env.LAB_LEAD_STAAT || join(env.HOME || homedir(), ".local/state/lab-lead");
}

/** Maakt een naam veilig voor gebruik als bestandsnaam. */
export function veilig(s: string): string {
  return (s || "onbekend").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "onbekend";
}

export function zorgVoorMappen(staat: string): void {
  mkdirSync(join(staat, "register"), { recursive: true, mode: 0o700 });
  mkdirSync(join(staat, "inbox"), { recursive: true, mode: 0o700 });
}

function schrijfAtomair(pad: string, inhoud: string): void {
  const tmp = `${pad}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, inhoud, { mode: 0o600 });
  renameSync(tmp, pad);
}

export function recordPad(staat: string, id: string): string {
  return join(staat, "register", `${veilig(id)}.json`);
}

export function leesRecord(staat: string, id: string): Rec | null {
  try {
    const r = JSON.parse(readFileSync(recordPad(staat, id), "utf8"));
    return r && typeof r === "object" ? (r as Rec) : null;
  } catch {
    return null;
  }
}

export function schrijfRecord(staat: string, r: Rec): void {
  zorgVoorMappen(staat);
  schrijfAtomair(recordPad(staat, r.id), `${JSON.stringify(r)}\n`);
}

export function nieuwRecord(id: string, env: Omgeving, cwd: string, nu: number): Rec {
  return {
    id,
    soort: "sessie",
    naam: env.LAB_AGENT_NAAM || "",
    rol: env.LAB_AGENT_ROL || "",
    lead: env.LAB_LEAD_NAAM || "",
    opdracht: env.LAB_OPDRACHT || "",
    cwd,
    pane: env.TMUX_PANE || "",
    toestand: "bezig",
    sinds: nu,
    start: nu,
    einde: null,
    laatste_tool: null,
    laatste_tool_om: null,
    tools_in_beurt: 0,
    rapport_om: null,
    rapport_in_beurt: false,
    vrij: false,
    blokkades: 0,
    ouder: null,
    agent_type: null,
  };
}

/** Leest een record; een ontbrekend of kapot record wordt een vers record uit de omgeving. */
export function leesOfMaak(staat: string, id: string, env: Omgeving, cwd: string, nu: number): Rec {
  const oud = leesRecord(staat, id);
  const vers = nieuwRecord(id, env, cwd, nu);
  return oud ? { ...vers, ...oud } : vers;
}

export function zetToestand(r: Rec, t: Toestand, nu: number): void {
  if (r.toestand !== t) r.sinds = nu;
  r.toestand = t;
}

export function alleRecords(staat: string): Rec[] {
  const uit: Rec[] = [];
  let namen: string[] = [];
  try {
    namen = readdirSync(join(staat, "register"));
  } catch {
    return uit;
  }
  for (const n of namen) {
    if (!n.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(staat, "register", n), "utf8"));
      if (r && typeof r === "object" && typeof r.id === "string") uit.push(r as Rec);
    } catch {
      // kapot record: negeren
    }
  }
  return uit;
}

/** Subagents van deze sessie die nog lopen (en niet al uren stil zijn). */
export function lopendeSubagents(staat: string, sessieId: string, nu: number, verouderdMs = 2 * 3600_000): Rec[] {
  return alleRecords(staat).filter(
    (r) => r.soort === "subagent" && r.ouder === sessieId && r.toestand === "bezig" && nu - (r.laatste_tool_om ?? r.sinds) < verouderdMs,
  );
}

// ---- inbox ----

export function inboxPad(staat: string, lead: string): string {
  return join(staat, "inbox", `${veilig(lead)}.jsonl`);
}
function gelezenPad(staat: string, lead: string): string {
  return join(staat, "inbox", `${veilig(lead)}.gelezen`);
}

function kapAf(s: string, maxBytes: number): string {
  let uit = s;
  while (Buffer.byteLength(uit) > maxBytes) uit = uit.slice(0, -1);
  return uit;
}

/** Eén regel naar de inbox van `lead`. Zonder lead gebeurt er niets. */
export function inboxMelding(staat: string, lead: string, van: string, tekst: string, nu: number): void {
  if (!lead) return;
  zorgVoorMappen(staat);
  const vanVeilig = kapAf(van, 60);
  const basis = JSON.stringify({ t: nu, van: vanVeilig, tekst: "" });
  const ruimte = MAX_REGEL_BYTES - Buffer.byteLength(basis) - 16; // marge voor JSON-escapes
  const regel = JSON.stringify({ t: nu, van: vanVeilig, tekst: kapAf(tekst, Math.max(20, ruimte)) });
  appendFileSync(inboxPad(staat, lead), `${regel}\n`, { mode: 0o600 });
}

export function inboxGrootte(staat: string, lead: string): number {
  try {
    return statSync(inboxPad(staat, lead)).size;
  } catch {
    return 0;
  }
}

export function gelezenOffset(staat: string, lead: string): number {
  try {
    const n = Number.parseInt(readFileSync(gelezenPad(staat, lead), "utf8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function zetGelezen(staat: string, lead: string, offset: number): void {
  zorgVoorMappen(staat);
  schrijfAtomair(gelezenPad(staat, lead), `${offset}\n`);
}

export type InboxRegel = { t: number; van: string; tekst: string };

/** Ongelezen regels (hoogstens `max`), het aantal dat er extra was en de nieuwe offset (einde van de laatste volledige regel). */
export function leesOngelezen(staat: string, lead: string, max = MAX_INBOX_REGELS): { regels: InboxRegel[]; meer: number; einde: number } {
  const pad = inboxPad(staat, lead);
  if (!existsSync(pad)) return { regels: [], meer: 0, einde: 0 };
  const buf = readFileSync(pad);
  let van = gelezenOffset(staat, lead);
  if (van > buf.length) van = 0; // bestand is korter geworden: opnieuw beginnen
  const einde = buf.lastIndexOf(0x0a) + 1; // alleen volledige regels
  if (einde <= van) return { regels: [], meer: 0, einde: van };
  const stuk = buf.subarray(van, einde).toString("utf8").split("\n").filter((l) => l.trim());
  const regels: InboxRegel[] = [];
  for (const l of stuk) {
    try {
      const o = JSON.parse(l);
      regels.push({ t: Number(o.t) || 0, van: String(o.van ?? ""), tekst: String(o.tekst ?? "") });
    } catch {
      // kapotte regel overslaan
    }
  }
  return { regels: regels.slice(0, max), meer: Math.max(0, regels.length - max), einde };
}

export function tijd(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function regelsTekst(r: { regels: InboxRegel[]; meer: number }): string {
  const t = r.regels.map((x) => `${x.van}: ${x.tekst} ${tijd(x.t)}`).join("; ");
  return r.meer > 0 ? `${t}; +${r.meer} meer` : t;
}

// ---- leadnamen ----

/** Naam van de lead zoals het register die kent; env (`LAB_AGENT_NAAM`) is alleen de beginwaarde. */
export function eigenLeadNaam(rec: Rec | null, env: Omgeving): string {
  return rec?.naam || env.LAB_AGENT_NAAM || env.LAB_LEAD_NAAM || "lead";
}

/** Naam van de lead van een agent: het record wint, env (`LAB_LEAD_NAAM`) is de beginwaarde. */
export function meldAdres(rec: Rec | null, env: Omgeving): string {
  return rec?.lead || env.LAB_LEAD_NAAM || "";
}

/** Pane-ids die tmux nu kent; null als dat niet te achterhalen is (dan telt elke pane als bestaand). */
export function tmuxPanes(): Set<string> | null {
  try {
    const p = Bun.spawnSync(["tmux", "list-panes", "-a", "-F", "#{pane_id}"], { stdout: "pipe", stderr: "ignore" });
    if (p.exitCode !== 0) return null;
    return new Set(p.stdout.toString().split("\n").map((x) => x.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/** Levende lead-records: niet `weg`, en de pane bestaat nog (of is onbekend). */
export function levendeLeads(staat: string, panes: Set<string> | null): Rec[] {
  const kand = alleRecords(staat).filter((r) => r.soort === "sessie" && r.rol === "lead" && r.toestand !== "weg" && (!r.pane || !panes || panes.has(r.pane)));
  // Panes worden hergebruikt: per pane telt alleen het record met de jongste start.
  const jongste = new Map<string, number>();
  for (const r of kand) if (r.pane) jongste.set(r.pane, Math.max(jongste.get(r.pane) ?? 0, r.start));
  return kand.filter((r) => !r.pane || jongste.get(r.pane) === r.start);
}

/** Andere levende leads met dezelfde naam als `naam` (het eigen record, `eigenId`, telt niet mee). */
export function dubbeleLeads(staat: string, naam: string, eigenId: string, panes: Set<string> | null): Rec[] {
  return levendeLeads(staat, panes).filter((r) => r.naam === naam && r.id !== eigenId);
}
