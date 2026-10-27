// Afgeleide peers-naam voor Brians eigen Codex-sessies (zonder identiteit): `codex-<laatste 12 hexcijfers van het sessie-id>`.
// Contract: CONTRACT.md, "Wijziging 27 okt". Server en hook leiden dezelfde naam af uit hetzelfde id (Codex: session_id van de
// hookinvoer = _meta.threadId van de MCP-aanroep).

import { heeftIdentiteitsbestand, type Omgeving } from "../hooks/register";

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
 */
export function magAfleiden(env: Omgeving, staat: string, cwd: string): boolean {
  return !env.LAB_AGENT_NAAM && !env.LAB_AGENT_ROL && !heeftIdentiteitsbestand(staat, cwd);
}
