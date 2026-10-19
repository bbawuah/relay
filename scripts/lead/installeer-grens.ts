#!/usr/bin/env bun
// Installeer merge.sh (en lead.conf) op een plek die agents niet kunnen wijzigen (root:wheel). Gebruik:
//   bun scripts/lead/installeer-grens.ts                 print de sudo-commando's voor Brian (voert niets uit)
//   bun scripts/lead/installeer-grens.ts --controleer    vergelijk de geïnstalleerde kopieën met origin/main
// Opties: --doel <map> (standaard /usr/local/lib/lab-lead); alleen voor tests: --eigenaar <uid>,
// --repo <map> (standaard deze checkout), --zonder-fetch en --testwortel <map> (voorouder-check stopt daar).
// Dit script draait zelf nooit sudo. De verwachte inhoud komt uit origin/main (vers opgehaald), niet uit
// de werkkopie: een agent kan de werkkopie aanpassen, origin/main alleen via een gemergede PR.
// Alleen merge.sh krijgt een allow-regel; push.sh en lab-lees.sh blijven voorlopig in de repo (vangnet).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { schoneEnv } from "../test-integriteit";

export const DOEL = "/usr/local/lib/lab-lead";
/** Bestand → modus. lead.conf hoort erbij: merge.sh leest hem naast zichzelf. */
export const BESTANDEN: Record<string, number> = { "merge.sh": 0o755, "lead.conf": 0o644 };
/** Pad van de bron in de repo. */
export const BRON_IN_REPO = "scripts/lead";

const sha = (inhoud: Buffer) => createHash("sha256").update(inhoud).digest("hex");
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function git(repo: string, args: string[]): Buffer {
  const p = spawnSync("git", ["-C", repo, ...args], { env: schoneEnv(), maxBuffer: 16 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim() || `status ${p.status}`}`);
  return p.stdout;
}

/** sha256 per bestand zoals het in origin/main staat (na een verse fetch, tenzij fetch=false). */
export function verwachteShas(repo: string, fetch = true): Record<string, string> {
  if (fetch) git(repo, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const uit: Record<string, string> = {};
  for (const naam of Object.keys(BESTANDEN)) uit[naam] = sha(git(repo, ["cat-file", "-p", `refs/remotes/origin/main:${BRON_IN_REPO}/${naam}`]));
  return uit;
}

export function commandos(bron: string, doel = DOEL): string[] {
  const uit = [`sudo install -d -o root -g wheel -m 755 ${q(doel)}`];
  for (const [naam, modus] of Object.entries(BESTANDEN))
    uit.push(`sudo install -o root -g wheel -m ${modus.toString(8)} ${q(path.join(bron, naam))} ${q(path.join(doel, naam))}`);
  return uit;
}

/**
 * Heeft het pad een ACL? Op macOS: `ls -led` toont dan een + achter de modus of ACL-regels eronder.
 * Elders: `getfacl --skip-base` (lege uitvoer = geen ACL) als dat er is, anders null (niet te controleren).
 */
export function heeftAcl(pad: string, platform: string = process.platform): boolean | null {
  const env = { PATH: "/usr/bin:/bin" };
  if (platform === "darwin") {
    const p = spawnSync("/bin/ls", ["-led", pad], { env });
    if (p.status !== 0) return true; // kan het niet zien: faalt dicht
    const regels = p.stdout.toString().split("\n").filter((r) => r.trim() !== "");
    return /^\S{10}\+/.test(regels[0] ?? "") || regels.length > 1;
  }
  const p = spawnSync("getfacl", ["--skip-base", "--absolute-names", pad], { env });
  if (p.error) return null; // geen getfacl
  if (p.status !== 0) return true;
  return p.stdout.toString().trim() !== "";
}

export type Uitslag = { ok: boolean; regels: string[] };

/**
 * testwortel (alleen voor tests): de voorouder-check stopt bij deze map (die zelf nog wel getoetst wordt),
 * omdat de tijdelijke map op Linux onder /tmp (1777) ligt. De echte installatie toetst tot /.
 */
export function controleer(verwacht: Record<string, string>, doel = DOEL, eigenaar = 0, testwortel?: string): Uitslag {
  const regels: string[] = [];
  let ok = true;
  let aclGemeld = false;
  const fout = (r: string) => {
    ok = false;
    regels.push(`FOUT ${r}`);
  };
  const veilig = (pad: string, wat: string, modus?: number, uids = [eigenaar]) => {
    const s = lstatSync(pad);
    if (s.isSymbolicLink()) return fout(`${wat}: is een symlink`), false;
    if (!uids.includes(s.uid)) return fout(`${wat}: eigenaar uid ${s.uid}, verwacht ${uids.join(" of ")} (root)`), false;
    if (s.mode & 0o022) return fout(`${wat}: schrijfbaar voor groep of anderen (modus ${(s.mode & 0o7777).toString(8)})`), false;
    if (modus !== undefined && (s.mode & 0o777) !== modus) return fout(`${wat}: modus ${(s.mode & 0o777).toString(8)}, verwacht ${modus.toString(8)}`), false;
    const acl = heeftAcl(pad);
    if (acl === null && !aclGemeld) {
      aclGemeld = true;
      regels.push(`LET OP ACL's niet gecontroleerd: geen ls -le of getfacl op ${process.platform}`);
    }
    if (acl) return fout(`${wat}: heeft een ACL (ls -led of getfacl); haal die weg`), false;
    return true;
  };
  if (!existsSync(doel)) {
    fout(`${doel} bestaat niet; draai eerst de sudo-commando's`);
    return { ok, regels };
  }
  // Het doel zelf: geen symlink ergens in het pad, en elke voorouder root-eigen en niet schrijfbaar voor anderen.
  if (realpathSync(doel) !== doel) {
    fout(`${doel}: het echte pad is ${realpathSync(doel)} (symlink in het pad)`);
    return { ok, regels };
  }
  for (let p = path.dirname(doel); ; p = path.dirname(p)) {
    if (!veilig(p, `voorouder ${p}`, undefined, [...new Set([0, eigenaar])])) return { ok, regels };
    if (p === "/" || p === testwortel) break;
  }
  if (!veilig(doel, doel)) return { ok, regels };
  for (const [naam, modus] of Object.entries(BESTANDEN)) {
    const pad = path.join(doel, naam);
    if (!existsSync(pad)) {
      fout(`${pad}: ontbreekt`);
      continue;
    }
    if (!veilig(pad, pad, modus)) continue;
    const a = verwacht[naam];
    const b = sha(readFileSync(pad));
    if (a !== b) fout(`${pad}: sha256 ${b.slice(0, 12)} wijkt af van origin/main (${a?.slice(0, 12)}); installeer opnieuw`);
    else regels.push(`OK   ${pad} ${b.slice(0, 12)}`);
  }
  return { ok, regels };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const stop = (m: string): never => {
    console.error(`installeer-grens: ${m}`);
    process.exit(1);
  };
  const waarde = (naam: string) => {
    const i = args.indexOf(naam);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) stop(`${naam} mist een waarde`);
    return v;
  };
  for (const a of args)
    if (a.startsWith("-") && !["--controleer", "--doel", "--eigenaar", "--repo", "--zonder-fetch", "--testwortel", "--help", "-h"].includes(a)) stop(`onbekende optie ${a}`);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 10).join("\n"));
    process.exit(0);
  }
  const repo = path.resolve(waarde("--repo") ?? path.join(import.meta.dir, "..", ".."));
  const bron = path.join(repo, BRON_IN_REPO);
  const doel = path.resolve(waarde("--doel") ?? DOEL);
  const eigenaar = Number(waarde("--eigenaar") ?? 0);
  if (!Number.isInteger(eigenaar) || eigenaar < 0) stop("--eigenaar is een uid");
  let verwacht: Record<string, string> = {};
  try {
    verwacht = verwachteShas(repo, !args.includes("--zonder-fetch"));
  } catch (e) {
    stop(`kan origin/main niet lezen: ${(e as Error).message}`);
  }
  if (args.includes("--controleer")) {
    const tw = waarde("--testwortel");
    const u = controleer(verwacht, doel, eigenaar, tw === undefined ? undefined : path.resolve(tw));
    for (const r of u.regels) console.log(r);
    console.log(u.ok ? `installeer-grens: ${doel} klopt met origin/main` : "installeer-grens: niet in orde");
    process.exit(u.ok ? 0 : 1);
  }
  // De sudo-regels installeren uit de werkkopie: die moet dus gelijk zijn aan origin/main.
  const afwijkend = Object.keys(BESTANDEN).filter((naam) => sha(readFileSync(path.join(bron, naam))) !== verwacht[naam]);
  if (afwijkend.length)
    stop(`${afwijkend.join(", ")} in ${bron} wijkt af van origin/main; installeer vanuit een schone checkout op origin/main`);
  console.log("# Dit script voert niets uit; Brian draait de regels hieronder zelf:");
  for (const c of commandos(bron, doel)) console.log(c);
  console.log(`# Controleer daarna zelf: shasum -a 256 ${doel}/*`);
  console.log("# Verwacht (uit origin/main):");
  for (const naam of Object.keys(BESTANDEN)) console.log(`#   ${verwacht[naam]}  ${path.join(doel, naam)}`);
  console.log(`# En: bun ${path.join(bron, "installeer-grens.ts")} --controleer`);
}
