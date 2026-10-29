// Draait een Codex-hook met de identiteit van de sessie in zijn omgeving.
//
//   codex-wrap.sh <commando> [argumenten…]     (stdin = hookinvoer van Codex, wordt doorgegeven)
//
// Hooks erven een gedeelde daemon-omgeving. Checkout-identiteit voorkomt verkeerde afzenderroutering.
// De bestaande lead-proef-sessiebinding blijft behouden; rollen verlenen geen privileges.
// Een ontbrekende optionele hook geeft een gewone hookfout, nooit een governanceblokkade.

import { bindLeadProefSessie, type Omgeving, staatMap, zoekIdentiteit } from "./register";

// afgeleide-naam ligt in de repo op ../peers en geïnstalleerd op ./peers (zie peers-kopie.ts). Een statische import zou
// geïnstalleerd falen en elke Codex-hook laten crashen (#685); faalt het laden, dan is er geen afgeleide naam en werkt de rest.
type AfgeleideNaam = { afgeleideNaam: (id: unknown) => string | null; magAfleiden: (env: Omgeving, staat: string, cwd: string) => boolean };
async function laadAfgeleideNaam(): Promise<AfgeleideNaam | null> {
  for (const map of ["./peers", "../peers"]) {
    try {
      return (await import(`${map}/afgeleide-naam`)) as AfgeleideNaam;
    } catch {
      // volgende pad
    }
  }
  return null;
}
const afgeleide = await laadAfgeleideNaam();

/** Wat de daemon van een andere sessie kan hebben doorgegeven en dus nooit zonder identiteitsbestand mag gelden. */
export const IDENTITEIT_SLEUTELS = ["LAB_AGENT_NAAM", "LAB_AGENT_ROL", "LAB_LEAD_NAAM", "LAB_OPDRACHT", "LAB_SPAWN_ID", "LAB_T3_THREAD", "LAB_LEAD_STAAT"];

/**
 * De omgeving voor het hookcommando. Met identiteitsbestand: dat wint van de daemon-omgeving. Zonder: alle identiteitssleutels
 * eruit, want de daemon-omgeving is van de sessie die hem startte (bijvoorbeeld een dode werker A) en niet van deze sessie
 * (anders registreert Brians eigen Codex-TUI zich als die werker).
 */
export function hookOmgeving(env: Omgeving, cwd: string, nu = Date.now(), sessieId = "", gebeurtenis = ""): Record<string, string> {
  const uit: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") uit[k] = v;
  if (gebeurtenis === "SessionStart") bindLeadProefSessie(staatMap(env), cwd, env.LAB_SPAWN_ID ?? "", sessieId, nu);
  const i = identiteitEnv(env, cwd, nu, sessieId);
  if (Object.keys(i).length > 0) return { ...uit, ...i };
  // Brians eigen Codex-sessie (geen identiteitsbestand, geen naam of rol in de omgeving): een afgeleide naam uit het sessie-id,
  // dezelfde als die van de peers-server (CONTRACT.md, "Wijziging 27 okt"). Rol en lead blijven leeg.
  const afgeleid = afgeleide?.magAfleiden(env, staatMap(env), cwd) ? afgeleide.afgeleideNaam(sessieId) : null;
  for (const k of IDENTITEIT_SLEUTELS) delete uit[k];
  if (afgeleid) uit.LAB_AGENT_NAAM = afgeleid;
  return uit;
}

/** Zoek de identiteit vanaf `cwd` omhoog; geeft de env die erover heen gaat, of niets. */
export function identiteitEnv(env: Omgeving, cwd: string, nu = Date.now(), sessieId = ""): Record<string, string> {
  const g = zoekIdentiteit(staatMap(env), cwd, nu);
  if (!g) return {};
  const i = g.identiteit;
  if (i.rol === "lead-proef" && i.sessie_id !== sessieId) return {};
  return { LAB_AGENT_NAAM: i.naam, LAB_AGENT_ROL: i.rol, LAB_LEAD_NAAM: i.lead, LAB_OPDRACHT: i.opdracht, LAB_SPAWN_ID: i.spawn_id, LAB_T3_THREAD: i.t3_thread ?? "" };
}

export function sessieUitInvoer(ruw: string): string {
  try {
    const j = JSON.parse(ruw);
    return j && typeof j.session_id === "string" ? j.session_id : "";
  } catch {
    return "";
  }
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
    const invoer = JSON.parse(ruw) as { hook_event_name?: unknown };
    env = hookOmgeving(process.env, cwdUitInvoer(ruw), Date.now(), sessieUitInvoer(ruw), typeof invoer.hook_event_name === "string" ? invoer.hook_event_name : "");
  } catch {
    // faalt open: de omgeving ongewijzigd
  }
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(cmd, { env, stdin: new TextEncoder().encode(ruw), stdout: "inherit", stderr: "inherit" });
  } catch (e) {
    process.stderr.write(`codex-wrap: kon ${cmd[0]} niet starten (${(e as Error).message})\n`);
    process.exit(1);
  }
  process.exit(await p.exited);
}

if (import.meta.main) await main();
