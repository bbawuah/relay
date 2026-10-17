#!/usr/bin/env bun
// Installeer de grens-scripts op een plek die agents niet kunnen wijzigen (root:wheel). Gebruik:
//   bun scripts/lead/installeer-grens.ts                 print de sudo-commando's voor Brian (voert niets uit)
//   bun scripts/lead/installeer-grens.ts --controleer    vergelijk de geïnstalleerde kopieën met de repo
// Opties: --doel <map> (standaard /usr/local/lib/lab-lead), --eigenaar <uid> (standaard 0, alleen voor tests).
// Dit script draait zelf nooit sudo. De allow-regels wijzen naar het doelpad, niet naar de repo:
// een agent kan scripts in de repo of een worktree aanpassen, maar niet in /usr/local/lib/lab-lead.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const DOEL = "/usr/local/lib/lab-lead";
/** Bestand → modus. lead.conf hoort erbij: merge.sh leest hem naast zichzelf. */
export const BESTANDEN: Record<string, number> = { "merge.sh": 0o755, "push.sh": 0o755, "lab-lees.sh": 0o755, "lead.conf": 0o644 };

const sha = (pad: string) => createHash("sha256").update(readFileSync(pad)).digest("hex");
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function commandos(bron: string, doel = DOEL): string[] {
  const uit = [`sudo install -d -o root -g wheel -m 755 ${q(doel)}`];
  for (const [naam, modus] of Object.entries(BESTANDEN))
    uit.push(`sudo install -o root -g wheel -m ${modus.toString(8)} ${q(path.join(bron, naam))} ${q(path.join(doel, naam))}`);
  return uit;
}

export type Uitslag = { ok: boolean; regels: string[] };

export function controleer(bron: string, doel = DOEL, eigenaar = 0): Uitslag {
  const regels: string[] = [];
  let ok = true;
  const fout = (r: string) => {
    ok = false;
    regels.push(`FOUT ${r}`);
  };
  const veilig = (pad: string, wat: string, modus?: number) => {
    const s = lstatSync(pad);
    if (s.isSymbolicLink()) return fout(`${wat}: is een symlink`), false;
    if (s.uid !== eigenaar) return fout(`${wat}: eigenaar uid ${s.uid}, verwacht ${eigenaar} (root)`), false;
    if (s.mode & 0o022) return fout(`${wat}: schrijfbaar voor groep of anderen (modus ${(s.mode & 0o777).toString(8)})`), false;
    if (modus !== undefined && (s.mode & 0o777) !== modus) return fout(`${wat}: modus ${(s.mode & 0o777).toString(8)}, verwacht ${modus.toString(8)}`), false;
    return true;
  };
  if (!existsSync(doel)) {
    fout(`${doel} bestaat niet; draai eerst de sudo-commando's`);
    return { ok, regels };
  }
  if (!veilig(doel, doel)) return { ok, regels };
  for (const [naam, modus] of Object.entries(BESTANDEN)) {
    const pad = path.join(doel, naam);
    if (!existsSync(pad)) {
      fout(`${pad}: ontbreekt`);
      continue;
    }
    if (!veilig(pad, pad, modus)) continue;
    const a = sha(path.join(bron, naam));
    const b = sha(pad);
    if (a !== b) fout(`${pad}: sha256 ${b.slice(0, 12)} wijkt af van de repo (${a.slice(0, 12)}); installeer opnieuw`);
    else regels.push(`OK   ${pad} ${b.slice(0, 12)}`);
  }
  return { ok, regels };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const waarde = (naam: string) => {
    const i = args.indexOf(naam);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) {
      console.error(`installeer-grens: ${naam} mist een waarde`);
      process.exit(1);
    }
    return v;
  };
  for (const a of args)
    if (a.startsWith("--") && !["--controleer", "--doel", "--eigenaar", "--help", "-h"].includes(a)) {
      console.error(`installeer-grens: onbekende optie ${a}`);
      process.exit(1);
    }
  if (args.includes("-h") || args.includes("--help")) {
    console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 7).join("\n"));
    process.exit(0);
  }
  const bron = import.meta.dir;
  const doel = path.resolve(waarde("--doel") ?? DOEL);
  const eigenaar = Number(waarde("--eigenaar") ?? 0);
  if (!Number.isInteger(eigenaar) || eigenaar < 0) {
    console.error("installeer-grens: --eigenaar is een uid");
    process.exit(1);
  }
  if (args.includes("--controleer")) {
    const u = controleer(bron, doel, eigenaar);
    for (const r of u.regels) console.log(r);
    console.log(u.ok ? `installeer-grens: ${doel} klopt met ${bron}` : "installeer-grens: niet in orde");
    process.exit(u.ok ? 0 : 1);
  }
  console.log("# Draai vanuit een schone checkout op origin/main (git status leeg, HEAD = origin/main).");
  console.log("# Dit script voert niets uit; Brian draait de regels hieronder zelf:");
  for (const c of commandos(bron, doel)) console.log(c);
  console.log("# sha256 van de bron, ter controle:");
  for (const naam of Object.keys(BESTANDEN)) console.log(`#   ${sha(path.join(bron, naam))}  ${naam}`);
  console.log(`# Daarna: bun ${path.join(bron, "installeer-grens.ts")} --controleer`);
}
