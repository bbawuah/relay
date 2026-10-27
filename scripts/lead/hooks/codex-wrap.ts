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
// Zonder identiteitsbestand draait het commando ongewijzigd (een `codex exec` heeft geen daemon, en grenzen.sh moet ook zonder rol
// werken). Faalt open: elke fout in de wrapper geeft het commando gewoon de invoer.

import { type Omgeving, staatMap, zoekIdentiteit } from "./register";

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
  let extra: Record<string, string> = {};
  try {
    extra = identiteitEnv(process.env, cwdUitInvoer(ruw));
  } catch {
    // faalt open
  }
  const p = Bun.spawn(cmd, { env: { ...process.env, ...extra }, stdin: new TextEncoder().encode(ruw), stdout: "inherit", stderr: "inherit" });
  process.exit(await p.exited);
}

if (import.meta.main) await main();
