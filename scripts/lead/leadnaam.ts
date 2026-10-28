// Hulp voor spawn.sh: leadnaam uit het register.
//   bun leadnaam.ts eigen                 naam van de lead in de pane $TMUX_PANE (leeg als onbekend)
//   bun leadnaam.ts bekend <naam>         exit 4 + uitleg als geen levend lead-record die naam draagt (register zonder map: geen toets)
//   bun leadnaam.ts dubbel <naam>         exit 3 + uitleg als een ander levend lead-record die naam draagt
// Alleen lezen. Staat: ${LAB_LEAD_STAAT:-~/.local/state/lab-lead}.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { alleRecords, dubbeleLeads, levendeLeads, staatMap, tmuxPanes } from "./hooks/register";

const staat = staatMap(process.env);
const pane = process.env.TMUX_PANE || "";
const [cmd, naam] = process.argv.slice(2);
const panes = tmuxPanes();
const eigen = pane ? levendeLeads(staat, panes).filter((r) => r.pane === pane).sort((a, b) => b.start - a.start)[0] : undefined;

// `lead-proef` mag werkers aan een Codex-lead koppelen, maar is bewust geen gewone
// lead: levendeLeads() blijft de bron voor dubbele leads en Terminal-B. Houd deze
// smallere toelating daarom lokaal bij de `bekend`-controle.
const bekendeLead = (gezochteNaam: string) =>
  alleRecords(staat).some(
    (r) =>
      r.soort === "sessie" &&
      (r.rol === "lead" || r.rol === "lead-proef") &&
      r.naam === gezochteNaam &&
      r.toestand !== "weg" &&
      (r.pane ? !panes || panes.has(r.pane) : Date.now() - r.sinds < 24 * 3600_000),
  );

if (cmd === "eigen") {
  if (eigen?.naam) console.log(eigen.naam);
} else if (cmd === "bekend" && naam) {
  // Zonder register (map ontbreekt) is er niets om aan te toetsen: een machine of test zonder peerbus.
  if (existsSync(join(staat, "register")) && !bekendeLead(naam)) {
    console.error(
      `spawn: lead '${naam}' staat niet in het register (${staat}); een rapport van de werker zou nergens aankomen ("onbekend"). Start de lead met de shell-functie \`lead\` (zet LAB_AGENT_ROL=lead en de naam), of herstart met: LAB_LEAD=1 LAB_AGENT_ROL=lead LAB_AGENT_NAAM=${naam} LAB_LEAD_NAAM=${naam} claude --resume <id> -n ${naam}`,
    );
    process.exit(4);
  }
} else if (cmd === "dubbel" && naam) {
  // Is de aanroeper herkend en heet zij anders, dan gaat het om de naam van een andere lead: niet toetsen.
  if (eigen && eigen.naam !== naam) process.exit(0);
  const anderen = dubbeleLeads(staat, naam, eigen?.id ?? "", panes);
  // Onbekende aanroeper: de lead zelf telt als een van de records, dubbel pas bij twee of meer.
  if (anderen.length > (eigen ? 0 : 1)) {
    const waar = anderen.map((r) => `sessie ${r.id.slice(0, 8)}${r.pane ? ` (pane ${r.pane})` : ""}`).join(", ");
    console.error(`spawn: er draait meer dan een lead met de naam '${naam}' (${waar}); de meldingen zouden door elkaar lopen. Geef --lead <unieke naam> (hernoem de lead eerst met scripts/lead/hernoem.ts).`);
    process.exit(3);
  }
} else {
  console.error("gebruik: leadnaam.ts eigen | bekend <naam> | dubbel <naam>");
  process.exit(2);
}
