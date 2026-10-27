// Afgeleide peers-naam voor Brians eigen Codex-sessies (zonder identiteit): `codex-<laatste 12 hexcijfers van het sessie-id>`.
// Contract: CONTRACT.md, "Wijziging 27 okt". Server en hook leiden dezelfde naam af uit hetzelfde id (Codex: session_id van de
// hookinvoer = _meta.threadId van de MCP-aanroep).

import { isAbsolute } from "node:path";
import { alleRecords, heeftIdentiteitsbestand, type Omgeving } from "../hooks/register";

export const AFGELEID_VOORVOEGSEL = "codex-";
const HEX = 12;

/** `codex-<laatste 12 tekens>` van een id (streepjes weg, alleen [0-9a-f]); null bij alles wat daar niet aan voldoet. */
export function afgeleideNaam(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const hex = id.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < HEX) return null;
  return `${AFGELEID_VOORVOEGSEL}${hex.slice(-HEX)}`;
}

/**
 * Mag een naam afgeleid worden? Alleen zonder LAB_AGENT_NAAM, zonder LAB_AGENT_ROL en zonder enig identiteitsbestand voor deze
 * map of een bovenliggende (ook een verlopen of kapot bestand telt: een werker die zijn identiteit kwijt is, blijft weigeren).
 * Een cwd dat geen absoluut pad is (de hookinvoer mist het of is vals) geeft nooit een naam.
 */
export function magAfleiden(env: Omgeving, staat: string, cwd: string): boolean {
  return isAbsolute(cwd) && !env.LAB_AGENT_NAAM && !env.LAB_AGENT_ROL && !heeftIdentiteitsbestand(staat, cwd);
}

/**
 * Staat er een levende registersessie met deze naam die niet de eigen sessie (`id`) is? Dan is de naam van een werker die
 * toevallig `codex-<12 hex>` heet, en mag de afgeleide naam niet gelden (anders leest deze sessie zijn inbox).
 */
export function botstMetLevendeSessie(staat: string, naam: string, id: string): boolean {
  return alleRecords(staat).some((r) => r.naam === naam && r.id !== id && r.toestand !== "weg" && !r.einde);
}
