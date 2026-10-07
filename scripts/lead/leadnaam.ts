// Hulp voor spawn.sh: leadnaam uit het register.
//   bun leadnaam.ts eigen                 naam van de lead in de pane $TMUX_PANE (leeg als onbekend)
//   bun leadnaam.ts dubbel <naam>         exit 3 + uitleg als een ander levend lead-record die naam draagt
// Alleen lezen. Staat: ${LAB_LEAD_STAAT:-~/.local/state/lab-lead}.

import { dubbeleLeads, levendeLeads, staatMap, tmuxPanes } from "./hooks/register";

const staat = staatMap(process.env);
const pane = process.env.TMUX_PANE || "";
const [cmd, naam] = process.argv.slice(2);
const panes = tmuxPanes();
const eigen = pane ? levendeLeads(staat, panes).filter((r) => r.pane === pane).sort((a, b) => b.start - a.start)[0] : undefined;

if (cmd === "eigen") {
  if (eigen?.naam) console.log(eigen.naam);
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
  console.error("gebruik: leadnaam.ts eigen | dubbel <naam>");
  process.exit(2);
}
