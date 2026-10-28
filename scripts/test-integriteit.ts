/**
 * Een kindproces krijgt nooit de GIT_*-omgeving van de aanroeper mee.
 * Relay-tests gebruiken dit bij tijdelijke repositories, zodat een hook of
 * worktree uit de hostomgeving hun git-opdrachten niet kan ombuigen.
 */
export function schoneEnv(bron: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(bron).filter(([naam, waarde]) => waarde !== undefined && !naam.startsWith("GIT_"))) as Record<string, string>;
}
