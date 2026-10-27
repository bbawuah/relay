// Controleert of de grenzen-hook (grenzen.sh) in een Codex-config staat én vertrouwd is.
//
//   bun codex-controle.ts [<config.toml>]       exit 0 = in orde, 1 = niet in orde (reden op stderr)
//
// spawn.sh --vendor codex roept dit aan vóór het starten: zonder de PreToolUse-groep voor grenzen.sh (matcher dekt Bash én
// apply_patch) of zonder een geldige `trusted_hash` voor die groep in `hooks.state` draait grenzen.sh stil niet (Codex slaat
// een ongetrust hook over) en gelden de rolregels niet. Dit is een statische controle op de config: of de hash nog klopt met
// de hookdefinitie ziet alleen Codex zelf (trustStatus `modified`); na een handmatige wijziging van het blok:
// codex-installeer.ts opnieuw draaien.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GRENZEN_MERK } from "./codex-installeer";

type Groep = { matcher?: unknown; hooks?: { command?: unknown }[] };

/** De naam waaronder Codex het vertrouwen van een hook bewaart: `<config.toml>:<event_snake>:<groep>:<handler>`. */
export function vertrouwSleutel(configPad: string, eventSnake: string, groep: number, handler: number): string {
  return `${configPad}:${eventSnake}:${groep}:${handler}`;
}

/** null = in orde, anders de reden. */
export function controleerGrenzen(configPad: string): string | null {
  if (!existsSync(configPad)) return `${configPad} bestaat niet`;
  let toml: { hooks?: { PreToolUse?: Groep[]; state?: Record<string, { trusted_hash?: unknown }> } };
  try {
    toml = Bun.TOML.parse(readFileSync(configPad, "utf8")) as typeof toml;
  } catch (e) {
    return `${configPad} is geen geldige TOML (${(e as Error).message.split("\n")[0]})`;
  }
  const groepen = toml.hooks?.PreToolUse;
  if (!Array.isArray(groepen)) return `${configPad} heeft geen PreToolUse-hooks`;
  const echt = realpathSync(configPad);
  let gezien = false;
  for (let g = 0; g < groepen.length; g++) {
    const hooks = Array.isArray(groepen[g]?.hooks) ? groepen[g].hooks! : [];
    for (let h = 0; h < hooks.length; h++) {
      if (typeof hooks[h]?.command !== "string" || !(hooks[h].command as string).includes(GRENZEN_MERK)) continue;
      gezien = true;
      const m = groepen[g].matcher;
      let dekt = false;
      try {
        dekt = typeof m === "string" && ["Bash", "apply_patch"].every((t) => new RegExp(m).test(t));
      } catch {
        dekt = false;
      }
      if (!dekt) continue;
      const hash = toml.hooks?.state?.[vertrouwSleutel(echt, "pre_tool_use", g, h)]?.trusted_hash;
      if (typeof hash === "string" && /^sha256:[0-9a-f]{64}$/.test(hash)) return null;
    }
  }
  return gezien
    ? `de grenzen-hook in ${configPad} is niet vertrouwd (geen geldige trusted_hash in hooks.state) of de matcher dekt Bash en apply_patch niet`
    : `de grenzen-hook (${GRENZEN_MERK}) ontbreekt in ${configPad}`;
}

if (import.meta.main) {
  const pad = process.argv[2] || join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex"), "config.toml");
  const r = controleerGrenzen(pad);
  if (r) {
    process.stderr.write(`${r}\nDraai: bun scripts/lead/hooks/codex-installeer.ts (eerst met --droog)\n`);
    process.exit(1);
  }
}
