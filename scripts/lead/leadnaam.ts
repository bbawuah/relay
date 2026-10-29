// Hulp voor spawn.sh: leadnaam uit het register.
//   bun leadnaam.ts eigen                 naam van de lead in de pane $TMUX_PANE (leeg als onbekend)
//   bun leadnaam.ts bekend <naam>         exit 4 + uitleg als geen levend lead-record die naam draagt (register zonder map: geen toets)
//   bun leadnaam.ts dubbel <naam>         exit 3 + uitleg als een ander levend lead-record die naam draagt
// Alleen lezen. Staat: ${LAB_LEAD_STAAT:-~/.local/state/lab-lead}.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { levendeSessies, staatMap, tmuxPanes } from "./hooks/register";

const staat = staatMap(process.env);
const pane = process.env.TMUX_PANE || "";
const [cmd, naam] = process.argv.slice(2);
const panes = tmuxPanes();
const sessies = levendeSessies(staat, panes);
const eigen = pane ? sessies.filter((r) => r.pane === pane).sort((a, b) => b.start - a.start)[0] : undefined;

// Een parent is een bereikbaar contact, geen privileged rol.
const bekendeLead = (gezochteNaam: string) => sessies.some((r) => r.naam === gezochteNaam);

if (cmd === "eigen") {
  if (eigen?.naam) console.log(eigen.naam);
} else if (cmd === "bekend" && naam) {
  // Zonder register (map ontbreekt) is er niets om aan te toetsen: een machine of test zonder peerbus.
  if (existsSync(join(staat, "register")) && !bekendeLead(naam)) {
    console.error(
      `spawn: lead '${naam}' staat niet in het register (${staat}); een bericht zou nergens aankomen ("onbekend"). Registreer of herstart de bedoelde sessie met deze naam via de optionele sessiehooks. Er is geen specifieke rol nodig.`,
    );
    process.exit(4);
  }
} else if (cmd === "dubbel" && naam) {
  const zelfDoel = eigen?.naam.toLowerCase() === naam.toLowerCase();
  const anderen = sessies.filter((r) => r.naam.toLowerCase() === naam.toLowerCase() && (!zelfDoel || r.id !== eigen?.id));
  // Onbekende aanroeper: de lead zelf telt als een van de records, dubbel pas bij twee of meer.
  if (anderen.length > (zelfDoel ? 0 : 1)) {
    const waar = anderen.map((r) => `sessie ${r.id.slice(0, 8)}${r.pane ? ` (pane ${r.pane})` : ""}`).join(", ");
    console.error(`spawn: er draait meer dan een lead met de naam '${naam}' (${waar}); de meldingen zouden door elkaar lopen. Geef --lead <unieke naam> (hernoem de lead eerst met scripts/lead/hernoem.ts).`);
    process.exit(3);
  }
} else {
  console.error("gebruik: leadnaam.ts eigen | bekend <naam> | dubbel <naam>");
  process.exit(2);
}
