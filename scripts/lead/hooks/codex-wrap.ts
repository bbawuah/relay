// Draait een Codex-hook met de identiteit van de sessie in zijn omgeving.
//
//   codex-wrap.sh <commando> [argumenten…]     (stdin = hookinvoer van Codex, wordt doorgegeven)
//
// Waarom: hooks van een Codex-sessie krijgen niet de omgeving van die sessie. De Codex-TUI draait threads in een gedeelde
// app-server-daemon per CODEX_HOME (blijft leven na de TUI); hooks erven de omgeving van de daemon, dus van de eerste codex die
// hem startte (gemeten 27 okt: een TUI met `env LAB_AGENT_NAAM=x codex` liet hooks LAB_AGENT_NAAM van een andere sessie zien).
// Een T3-thread heeft helemaal geen eigen omgeving. Toch hebben hook.ts en grenzen.sh LAB_AGENT_ROL nodig (grenzen.sh past de
// hoofdcheckout-regel alleen toe met een rol; Codex stuurt geen agent_id). spawn.sh --vendor codex schrijft daarom de identiteit
// naar <staat>/identiteit/<hash van de checkout>.json; deze wrapper zoekt vanaf de cwd uit de hookinvoer omhoog naar dat bestand
// en zet LAB_* in de omgeving van het commando; een gevonden identiteit wint van de (mogelijk verouderde) daemon-omgeving.
// Zonder identiteitsbestand gaan de identiteitssleutels uit de omgeving (de daemon-omgeving is van een andere sessie; Brians eigen
// Codex draait dan als Brian: hook.sh stopt zonder rol en grenzen.sh past de rolregels niet toe). Faalt open op eigen fouten.
// Zonder bun faalt de wrapper luid bij PreToolUse (exit 2): zonder wrapper geen identiteit en dus geen rolregels in grenzen.sh.

import { type Omgeving, staatMap, zoekIdentiteit } from "./register";

/** Wat de daemon van een andere sessie kan hebben doorgegeven en dus nooit zonder identiteitsbestand mag gelden. */
export const IDENTITEIT_SLEUTELS = ["LAB_AGENT_NAAM", "LAB_AGENT_ROL", "LAB_LEAD_NAAM", "LAB_OPDRACHT", "LAB_SPAWN_ID", "LAB_T3_THREAD", "LAB_LEAD_STAAT"];

/**
 * De omgeving voor het hookcommando. Met identiteitsbestand: dat wint van de daemon-omgeving. Zonder: alle identiteitssleutels
 * eruit, want de daemon-omgeving is van de sessie die hem startte (bijvoorbeeld een dode werker A) en niet van deze sessie
 * (anders registreert Brians eigen Codex-TUI zich als die werker).
 */
export function hookOmgeving(env: Omgeving, cwd: string, nu = Date.now()): Record<string, string> {
  const uit: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") uit[k] = v;
  const i = identiteitEnv(env, cwd, nu);
  if (Object.keys(i).length > 0) return { ...uit, ...i };
  for (const k of IDENTITEIT_SLEUTELS) delete uit[k];
  return uit;
}

/** Zoek de identiteit vanaf `cwd` omhoog; geeft de env die erover heen gaat, of niets. */
export function identiteitEnv(env: Omgeving, cwd: string, nu = Date.now()): Record<string, string> {
  const g = zoekIdentiteit(staatMap(env), cwd, nu);
  if (!g) return {};
  const i = g.identiteit;
  return { LAB_AGENT_NAAM: i.naam, LAB_AGENT_ROL: i.rol, LAB_LEAD_NAAM: i.lead, LAB_OPDRACHT: i.opdracht, LAB_SPAWN_ID: i.spawn_id, LAB_T3_THREAD: i.t3_thread ?? "" };
}

export function cwdUitInvoer(ruw: string): string {
  try {
    const j = JSON.parse(ruw);
    return j && typeof j.cwd === "string" ? j.cwd : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const cmd = process.argv.slice(2);
  if (cmd.length === 0) process.exit(0);
  const ruw = await Bun.stdin.text();
  let env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  try {
    env = hookOmgeving(process.env, cwdUitInvoer(ruw));
  } catch {
    // faalt open: de omgeving ongewijzigd
  }
  const p = Bun.spawn(cmd, { env, stdin: new TextEncoder().encode(ruw), stdout: "inherit", stderr: "inherit" });
  process.exit(await p.exited);
}

if (import.meta.main) await main();
