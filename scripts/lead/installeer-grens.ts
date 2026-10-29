#!/usr/bin/env bun
// Installeer uitsluitend de WebAuthn-commandorunner op een beschermd pad
// (root:wheel). Gebruik:
//   bun scripts/lead/installeer-grens.ts                 print de sudo-commando's voor Brian (voert niets uit)
//   bun scripts/lead/installeer-grens.ts --controleer    vergelijk de geïnstalleerde kopieën met origin/main
//   bun scripts/lead/installeer-grens.ts --sleutels-export <uit> --login <login> --rpid <host> --origin <url>   alleen Brian
// Opties: --doel <map> (standaard /usr/local/lib/lab-lead); alleen voor tests: --eigenaar <uid>,
// --repo <map> (standaard deze checkout), --zonder-fetch, --testwortel <map> (voorouder-check stopt daar),
// --plist <pad> en --passkeys <pad>.
// Dit script draait zelf nooit sudo. De verwachte inhoud komt uit origin/main (vers opgehaald), niet uit
// de werkkopie: een agent kan de werkkopie aanpassen, origin/main alleen via een gemergede PR.
// Geen mergepolicy installeren; runner, sleutels en eigenaarcontroles blijven behouden.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { schoneEnv } from "../test-integriteit";
import { gitArgs } from "./git-hard";
import { valideerSleutels, type Sleutels } from "./commando/sleutels";

export const DOEL = "/usr/local/lib/lab-lead";
/** Geen mergepolicybestanden; de beschermde WebAuthn-runner blijft behouden. */
export const BESTANDEN: Record<string, number> = {};
/** Pad van de bron in de repo. */
export const BRON_IN_REPO = "scripts/lead";
/** De commando-runner: een bundel die uit origin/main gebouwd wordt (bun build is deterministisch bij dezelfde bun en bun.lock). */
export const RUNNER = "commando-runner.js";
export const RUNNER_BRON = "scripts/lead/commando/runner.ts";
/** Publieke passkey-sleutels voor de runner; niet uit de repo, maar door Brian geëxporteerd (--sleutels-export). */
export const SLEUTELS = "passkeys.pub";
export const PLIST_SJABLOON = "scripts/lead/commando/nl.lab-b.commando.plist.sjabloon";
export const PLIST_NAAM = "nl.lab-b.commando.plist";
/** Modus per geïnstalleerd bestand. */
export const MODI: Record<string, number> = { ...BESTANDEN, [RUNNER]: 0o755, [SLEUTELS]: 0o644 };

const sha = (inhoud: Buffer | string) => createHash("sha256").update(inhoud).digest("hex");
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function git(repo: string, args: string[]): Buffer {
  const p = spawnSync("git", ["-C", repo, ...gitArgs(args)], { env: schoneEnv(), maxBuffer: 16 * 1024 * 1024 });
  // p.error: bv. ENOBUFS als de uitvoer groter is dan maxBuffer (dan is status null en stderr leeg)
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim() || p.error?.message || `status ${p.status}`}`);
  return p.stdout;
}

const ORIGIN_MAIN = "refs/remotes/origin/main";

function draai(cmd: string[], cwd: string): void {
  const p = spawnSync(cmd[0]!, cmd.slice(1), { cwd, env: schoneEnv(), maxBuffer: 16 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr?.toString().trim().slice(-500) || `status ${p.status}`}`);
}

/**
 * Bouwt de runner-bundel uit origin/main: `git archive` naar een tijdelijke map, `bun install
 * --frozen-lockfile --ignore-scripts` (als er een package.json is) en `bun build`. Nooit uit de werkkopie.
 */
export function bouwRunner(repo: string): { pad: string; sha: string; bun: string } {
  const map = mkdtempSync(path.join(tmpdir(), "commando-runner-bouw-"));
  const bron = path.join(map, "bron");
  mkdirSync(bron);
  // Direct naar het bestand, niet via stdout: het archief van de hele repo is groter dan elke vaste buffer.
  git(repo, ["archive", "--format=tar", "-o", path.join(map, "bron.tar"), ORIGIN_MAIN]);
  draai(["tar", "-xf", path.join(map, "bron.tar"), "-C", bron], map);
  if (existsSync(path.join(bron, "package.json"))) draai(["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--silent"], bron);
  const pad = path.join(map, RUNNER);
  draai(["bun", "build", RUNNER_BRON, "--target=bun", "--outfile", pad], bron);
  return { pad, sha: sha(readFileSync(pad)), bun: Bun.version };
}

/** Staat de runner in origin/main? Pas dan hoort hij bij de installatie. */
export function heeftRunner(repo: string): boolean {
  return spawnSync("git", ["-C", repo, ...gitArgs(["cat-file", "-e", `${ORIGIN_MAIN}:${RUNNER_BRON}`])], { env: schoneEnv() }).status === 0;
}

/** De LaunchAgent zoals hij uit het sjabloon in origin/main komt, voor deze HOME. */
export function plistUit(repo: string, home: string): string {
  return git(repo, ["cat-file", "-p", `${ORIGIN_MAIN}:${PLIST_SJABLOON}`]).toString().replaceAll("{{HOME}}", home);
}

export type Verwacht = { shas: Record<string, string>; runner?: { pad: string; bun: string }; plist?: string };

/** Wat er geïnstalleerd hoort te zijn volgens origin/main (na een verse fetch, tenzij fetch=false). */
export function verwacht(repo: string, fetch = true, home = homedir()): Verwacht {
  if (fetch) git(repo, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const shas: Record<string, string> = {};
  for (const naam of Object.keys(BESTANDEN)) shas[naam] = sha(git(repo, ["cat-file", "-p", `${ORIGIN_MAIN}:${BRON_IN_REPO}/${naam}`]));
  if (!heeftRunner(repo)) return { shas };
  const r = bouwRunner(repo);
  shas[RUNNER] = r.sha;
  return { shas, runner: { pad: r.pad, bun: r.bun }, plist: plistUit(repo, home) };
}

/** sha256 per bestand zoals het in origin/main staat (na een verse fetch, tenzij fetch=false). */
export function verwachteShas(repo: string, fetch = true): Record<string, string> {
  return verwacht(repo, fetch).shas;
}

export function commandos(bron: string, doel = DOEL, runner?: string): string[] {
  const uit = [`sudo install -d -o root -g wheel -m 755 ${q(doel)}`];
  for (const [naam, modus] of Object.entries(BESTANDEN))
    uit.push(`sudo install -o root -g wheel -m ${modus.toString(8)} ${q(path.join(bron, naam))} ${q(path.join(doel, naam))}`);
  if (runner) uit.push(`sudo install -o root -g wheel -m 755 ${q(runner)} ${q(path.join(doel, RUNNER))}`);
  return uit;
}

/** Kort id van een passkey: de eerste 8 tekens van de credential-id, om te vergelijken met Terminal B. */
export const kortId = (credentialId: string) => credentialId.slice(0, 8);

/** "<naam> <JJJJ-MM-DD>" in printbare ASCII (het formaat van passkeys.pub), hooguit 64 tekens. */
export function apparaatVan(naam: unknown, aangemaakt: unknown): string {
  const datum = typeof aangemaakt === "string" && /^\d{4}-\d{2}-\d{2}/.test(aangemaakt) ? aangemaakt.slice(0, 10) : "zonder-datum";
  const n = (typeof naam === "string" && naam.trim() ? naam.trim() : "zonder naam").replace(/[^\x20-\x7e]/g, "?").slice(0, 64 - datum.length - 1);
  return `${n} ${datum}`;
}

/**
 * Alleen Brian: zet de publieke delen van zijn eigen passkeys (alleen `login`) uit de opslag van de tmux-app
 * ({"passkeys":[{login, id, publicKey, naam, aangemaakt, …}]}) om naar passkeys.pub. Per sleutel gaan mee:
 * credential-id, publieke sleutel en `apparaat` (naam en aanmaakdatum, om te herkennen). Geen login, tellers
 * of transports. Schrijft `uit` met modus 600 en weigert een bestaand bestand. Geeft een overzicht per
 * sleutel, de sha256 van het bestand en de regels om het te installeren en daarna te wissen.
 */
export function exporteerSleutels(
  passkeys: string,
  uit: string,
  rpID: string,
  origins: string[],
  login: string,
  doel = DOEL,
): { sleutels: Sleutels; overzicht: string[]; sha256: string; regels: string[] } {
  const ruw = JSON.parse(readFileSync(passkeys, "utf8")) as { passkeys?: unknown };
  if (!Array.isArray(ruw.passkeys)) throw new Error(`${passkeys}: geen lijst passkeys`);
  const van = ruw.passkeys.filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && (p as { login?: unknown }).login === login);
  if (!van.length) throw new Error(`${passkeys}: geen passkeys voor login ${login}`);
  const sleutels = valideerSleutels({
    versie: 1,
    rpID,
    origins,
    sleutels: van.map((p) => ({ credentialId: p.id, publicKey: p.publicKey, apparaat: apparaatVan(p.naam, p.aangemaakt) })),
  });
  const inhoud = `${JSON.stringify(sleutels, null, 2)}\n`;
  const fd = openSync(uit, "wx", 0o600);
  try {
    writeSync(fd, inhoud);
  } finally {
    closeSync(fd);
  }
  return {
    sleutels,
    overzicht: sleutels.sleutels.map((k) => `${kortId(k.credentialId)}  ${k.apparaat}`),
    sha256: sha(inhoud),
    regels: [`sudo install -o root -g wheel -m 644 ${q(uit)} ${q(path.join(doel, SLEUTELS))}`, `rm ${q(uit)}`],
  };
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
export function controleer(
  verwacht: Record<string, string>,
  doel = DOEL,
  eigenaar = 0,
  testwortel?: string,
  commando?: { plist: string; plistPad: string; bun?: string },
): Uitslag {
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
  for (const naam of Object.keys(verwacht)) {
    const pad = path.join(doel, naam);
    if (!existsSync(pad)) {
      fout(`${pad}: ontbreekt`);
      continue;
    }
    if (!veilig(pad, pad, MODI[naam])) continue;
    const a = verwacht[naam];
    const b = sha(readFileSync(pad));
    const bun = naam === RUNNER && commando?.bun ? ` (gebouwd met bun ${commando.bun}; een andere bun-versie geeft een andere bundel)` : "";
    if (a !== b) fout(`${pad}: sha256 ${b.slice(0, 12)} wijkt af van origin/main (${a?.slice(0, 12)})${bun}; installeer opnieuw`);
    else regels.push(`OK   ${pad} ${b.slice(0, 12)}`);
  }
  if (RUNNER in verwacht) {
    // passkeys.pub komt niet uit de repo: alleen eigenaar, modus en een geldig formaat (zonder de inhoud te tonen).
    const pad = path.join(doel, SLEUTELS);
    if (!existsSync(pad)) fout(`${pad}: ontbreekt; zie scripts/lead/commando/INSTALLEREN.md`);
    else if (veilig(pad, pad, MODI[SLEUTELS])) {
      try {
        const inhoud = readFileSync(pad, "utf8");
        const { sleutels } = valideerSleutels(JSON.parse(inhoud));
        const n = sleutels.length;
        regels.push(`OK   ${pad} sha256 ${sha(inhoud).slice(0, 12)} (${n} ${n === 1 ? "sleutel" : "sleutels"}; vergelijk met de passkeys in Terminal B)`);
        for (const k of sleutels) regels.push(`       ${kortId(k.credentialId)}  ${k.apparaat ?? "(geen apparaat)"}`);
      } catch (e) {
        fout(`${pad}: ${(e as Error).message}`);
      }
    }
    // De LaunchAgent is een bestand van Brian (ook voor agents schrijfbaar): een vangnet, geen grens.
    if (commando) {
      if (!existsSync(commando.plistPad)) fout(`${commando.plistPad}: ontbreekt; zie scripts/lead/commando/INSTALLEREN.md`);
      else if (lstatSync(commando.plistPad).isSymbolicLink()) fout(`${commando.plistPad}: is een symlink`);
      else if (readFileSync(commando.plistPad, "utf8") !== commando.plist) fout(`${commando.plistPad}: wijkt af van het sjabloon in origin/main; zet hem opnieuw neer`);
      else regels.push(`OK   ${commando.plistPad}`);
    }
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
  const opties = ["--controleer", "--doel", "--eigenaar", "--repo", "--zonder-fetch", "--testwortel", "--plist", "--passkeys", "--sleutels-export", "--login", "--rpid", "--origin", "--help", "-h"];
  for (const a of args) if (a.startsWith("-") && !opties.includes(a)) stop(`onbekende optie ${a}`);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 12).join("\n"));
    process.exit(0);
  }
  const uitExport = waarde("--sleutels-export");
  if (uitExport) {
    // Leest de passkey-opslag van de tmux-app: dit draait alleen Brian, nooit een agent.
    const login = waarde("--login") ?? stop("--sleutels-export vraagt --login <jouw login in Terminal B>");
    const rpID = waarde("--rpid") ?? stop("--sleutels-export vraagt --rpid <host van Terminal B>");
    const origins = args.flatMap((a, i) => (a === "--origin" && args[i + 1] ? [args[i + 1]!] : []));
    if (!origins.length) stop("--sleutels-export vraagt --origin <url van Terminal B>");
    const passkeys = waarde("--passkeys") ?? path.join(homedir(), ".config/tmux-pwa/passkeys.json");
    try {
      const { sleutels, overzicht, sha256, regels } = exporteerSleutels(passkeys, path.resolve(uitExport), rpID, origins, login, path.resolve(waarde("--doel") ?? DOEL));
      const n = sleutels.sleutels.length;
      console.log(`# ${n} publieke ${n === 1 ? "sleutel" : "sleutels"} van ${login} in ${uitExport} (modus 600). Vergelijk met de passkeys in Terminal B:`);
      for (const r of overzicht) console.log(`#   ${r}`);
      console.log(`# sha256 ${sha256}  (na de installatie: shasum -a 256 ${path.join(path.resolve(waarde("--doel") ?? DOEL), SLEUTELS)})`);
      console.log("# Installeer en wis:");
      for (const r of regels) console.log(r);
    } catch (e) {
      stop((e as Error).message);
    }
    process.exit(0);
  }
  const repo = path.resolve(waarde("--repo") ?? path.join(import.meta.dir, "..", ".."));
  const bron = path.join(repo, BRON_IN_REPO);
  const doel = path.resolve(waarde("--doel") ?? DOEL);
  const eigenaar = Number(waarde("--eigenaar") ?? 0);
  if (!Number.isInteger(eigenaar) || eigenaar < 0) stop("--eigenaar is een uid");
  let v: Verwacht = { shas: {} };
  try {
    v = verwacht(repo, !args.includes("--zonder-fetch"));
  } catch (e) {
    stop(`kan origin/main niet lezen of de runner niet bouwen: ${(e as Error).message}`);
  }
  const plistPad = path.resolve(waarde("--plist") ?? path.join(homedir(), "Library/LaunchAgents", PLIST_NAAM));
  if (args.includes("--controleer")) {
    const tw = waarde("--testwortel");
    const commando = v.plist === undefined ? undefined : { plist: v.plist, plistPad, bun: v.runner?.bun };
    const u = controleer(v.shas, doel, eigenaar, tw === undefined ? undefined : path.resolve(tw), commando);
    for (const r of u.regels) console.log(r);
    console.log(u.ok ? `installeer-grens: ${doel} klopt met origin/main` : "installeer-grens: niet in orde");
    process.exit(u.ok ? 0 : 1);
  }
  // De sudo-regels installeren uit de werkkopie: die moet dus gelijk zijn aan origin/main.
  const afwijkend = Object.keys(BESTANDEN).filter((naam) => sha(readFileSync(path.join(bron, naam))) !== v.shas[naam]);
  if (afwijkend.length)
    stop(`${afwijkend.join(", ")} in ${bron} wijkt af van origin/main; installeer vanuit een schone checkout op origin/main`);
  console.log("# Dit script voert niets uit; Brian draait de regels hieronder zelf:");
  for (const c of commandos(bron, doel, v.runner?.pad)) console.log(c);
  console.log(`# Controleer daarna zelf: shasum -a 256 ${doel}/*`);
  console.log("# Verwacht (uit origin/main):");
  for (const naam of Object.keys(v.shas)) console.log(`#   ${v.shas[naam]}  ${path.join(doel, naam)}`);
  if (v.plist !== undefined) {
    console.log(`# De runner is gebouwd met bun ${v.runner?.bun}. passkeys.pub en de LaunchAgent: zie scripts/lead/commando/INSTALLEREN.md.`);
    console.log(`# LaunchAgent voor ${plistPad} (zonder sudo; Brian zet hem neer en laadt hem zelf):`);
    for (const r of v.plist.trimEnd().split("\n")) console.log(`#| ${r}`);
  }
  console.log(`# En: bun ${path.join(bron, "installeer-grens.ts")} --controleer`);
}
