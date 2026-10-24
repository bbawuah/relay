// Bewaker voor de poortstap scripts-tests: die draait lokaal alleen als de diff een pad uit
// SCRIPTS_TESTS_PADEN raakt (scriptsTestsOverslaan in poort.ts). Leest of importeert een scripts-test
// een bestand buiten scripts/, dan moet dat pad in die lijst staan; anders slaat de poort de test over
// terwijl een wijziging aan dat bestand hem kan breken. Deze test wordt rood zodra dat gebeurt.
//
// Detectie (statisch, bewust simpel). Een pad telt als het buiten scripts/ ligt en op een van deze
// manieren wordt aangewezen:
//  1. join/resolve(<anker>, "seg", ...) met literale segmenten; anker is import.meta.dir(name) of
//     __dirname (relatief aan het testbestand, ".." wordt echt opgelost) of een naam met ROOT of REPO
//     (de repo-root);
//  2. een literal die met ../ begint (import, new URL, cpSync, enz.), opgelost vanaf het testbestand;
//  3. een literal die direct aan new Glob( / Bun.file( / readFileSync( / existsSync( / readdirSync( wordt
//     gegeven en met apps/, packages/, tools/, .githooks/, .github/ (ook {apps,packages,tools}/) begint
//     of een root-bestand is;
//  4. een template die met een anker begint: `${import.meta.dir}/../packages/x`.
// Een los literal als "apps/x/a.ts" in een functieargument of join(tmpdir, ...) is data of een fixture
// in een wegwerpmap en telt dus niet. Een pad telt bovendien alleen als het in de echte repo bestaat
// (bestand, map of begin van een bestandsnaam, zodat een extensieloze import meetelt). Een glob of
// template (`*`, `${`) wordt op zijn vaste voorkant getoetst. node_modules telt niet (dat is bun.lock).
//
// Vangt NIET: paden die uit variabelen worden samengesteld (join(ROOT, map, "x"); new Bun.Glob(p) met
// een variabele, zoals turbo-inputs.test.ts: die dekking komt alleen uit de lijst); ankers met een andere
// naam dan hierboven; een test die een scanner op de hele repo draait (ds-regels, echte-klok,
// werk-commentaar enz. lezen alle getrackte bestanden: een wijziging in een app kan zo een scripts-test
// breken zonder dat een literal het zegt); helpers in scripts/ die geen *.test.ts zijn en zelf buiten
// scripts/ lezen; imports via de pakketnaam (@lab-bawuah/...). Die gevallen vangt alleen CI (`--ci`)
// of `--alles`.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { scriptsTestsOverslaan } from "./poort";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPTS = join(ROOT, "scripts");

const ROOTBESTAND = /^(?:[\w-]+\.(?:json|jsonc|toml|lock|md|ya?ml)|\.[\w-]+)$/;
const VOORVOEGSEL = /^(?:(?:apps|packages|tools)(?:\/|$)|\.githooks(?:\/|$)|\.github(?:\/|$))/;
const PADTEKENS = /^[\w@.*${},/-]+$/;
const LIT = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\x60[^\x60\n]*\x60)`;
const ontcijfer = (l: string) => l.slice(1, -1);

/** Bestaat dit pad in de repo (bestand, map, of begin van een bestandsnaam zoals een extensieloze import)? */
export function bestaatInRepo(pad: string, root = ROOT): boolean {
  const abs = join(root, pad);
  if (existsSync(abs)) return true;
  try {
    const naam = abs.slice(dirname(abs).length + 1);
    return readdirSync(dirname(abs)).some((f) => f.startsWith(`${naam}.`));
  } catch {
    return false;
  }
}

/**
 * De repo-relatieve paden buiten scripts/ die een testtekst aanwijst (zie de kop voor de regels).
 * `dir` is de map van het testbestand (voor import.meta.dir en ../), `root` de repo-root.
 */
export function kandidaatPaden(tekst: string, dir = SCRIPTS, root = ROOT): string[] {
  const uit = new Set<string>();
  const voeg = (abs: string) => {
    const rel = relative(root, abs).split(sep).join("/");
    if (!rel || rel.startsWith("..") || rel === "scripts" || rel.startsWith("scripts/")) return;
    if (rel === "node_modules" || rel.startsWith("node_modules/")) return;
    if (!PADTEKENS.test(rel)) return;
    uit.add(rel);
  };
  // 1. join/resolve met een anker
  const call = new RegExp(String.raw`\b(?:path\.)?(?:join|resolve)\(\s*(import\.meta\.dir(?:name)?|__dirname|[A-Z_]*(?:ROOT|REPO)[A-Z_]*)((?:\s*,\s*${LIT})*)\s*\)`, "g");
  for (const m of tekst.matchAll(call)) {
    const segs = [...(m[2] ?? "").matchAll(new RegExp(LIT, "g"))].map((x) => ontcijfer(x[0]));
    const basis = (m[1] ?? "").startsWith("import.meta") || m[1] === "__dirname" ? dir : root;
    voeg(resolve(basis, ...segs));
  }
  // 2. een literal met ../ (ook die in een anker-aanroep: dubbel tellen is onschadelijk)
  for (const m of tekst.matchAll(new RegExp(LIT, "g"))) {
    const l = ontcijfer(m[0]);
    if (l.startsWith("../")) voeg(resolve(dir, l));
  }
  // 3. een literal direct aan een fs-aanroep, relatief aan de repo-root
  const fs = new RegExp(String.raw`(?:new Glob|Bun\.file|readFileSync|readFile|existsSync|readdirSync|statSync)\(\s*(${LIT})`, "g");
  for (const m of tekst.matchAll(fs)) {
    const l = ontcijfer(m[1] ?? "");
    // {apps,packages,tools}/…: de enige accolade-glob die we uitvouwen
    const lijst = l.startsWith("{apps,packages,tools}/") ? ["apps", "packages", "tools"].map((d) => d + l.slice("{apps,packages,tools}".length)) : [l];
    for (const x of lijst) if (VOORVOEGSEL.test(x) || ROOTBESTAND.test(x)) voeg(resolve(root, x));
  }
  // 4. een template die met een anker begint: `${import.meta.dir}/../packages/x`
  for (const m of tekst.matchAll(new RegExp(LIT, "g"))) {
    const t = /^\$\{(import\.meta\.dir(?:name)?|__dirname|[A-Z_]*(?:ROOT|REPO)[A-Z_]*)\}\/([^$]*)$/.exec(ontcijfer(m[0]));
    if (t) voeg(resolve(/^(import|__dirname)/.test(t[1] ?? "") ? dir : root, t[2] ?? ""));
  }
  return [...uit];
}

const concreet = (p: string) =>
  p
    .replace(/\$\{[^}]*\}/g, "x")
    .replace(/\{([^},]*)[^}]*\}/g, "$1") // {,c} wordt "" (eerste alternatief)
    .replace(/\*+/g, "x");

/** Paden die de tekst aanwijst, echt bestaan en niet door scriptsTestsOverslaan als "draaien" gelden. */
export function ongedekt(tekst: string, bestaat: (p: string) => boolean = bestaatInRepo, dir = SCRIPTS): string[] {
  const affected = { alles: false, ci: false };
  return kandidaatPaden(tekst, dir).filter((p) => {
    const patroon = /[*{]/.test(p);
    const vast = (patroon ? (p.split(/[*{$]/)[0] ?? "") : p).replace(/\/$/, "");
    if (patroon && !vast) return false;
    if (!bestaat(vast)) return false;
    return scriptsTestsOverslaan(affected, [concreet(p)]) !== null;
  });
}

function testBestanden(map: string): string[] {
  return readdirSync(map, { withFileTypes: true }).flatMap((e) => {
    const p = join(map, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : testBestanden(p);
    return e.name.endsWith(".test.ts") ? [p] : [];
  });
}

const alles = () => true;

describe("scripts-tests-paden: elk pad buiten scripts/ dat een scripts-test leest, laat scripts-tests draaien", () => {
  test("negatief: een fixturetekst die een bestaand pad buiten de lijst leest is rood", () => {
    const tekst = 'const s = readFileSync(join(ROOT, "apps/x/src/gevoelig.ts"), "utf8");';
    expect(ongedekt(tekst, alles)).toEqual(["apps/x/src/gevoelig.ts"]);
  });
  test("negatief: losse join-segmenten, een ../-import, een root-bestand en een glob worden ook gezien", () => {
    expect(ongedekt('join(ROOT, "packages", "ui", "src")', alles)).toEqual(["packages/ui/src"]);
    expect(ongedekt('import x from "../../tools/brein/x";', alles, join(SCRIPTS, "lead"))).toEqual(["tools/brein/x"]);
    expect(ongedekt('Bun.file("biome.json")', alles)).toEqual(["biome.json"]);
    expect(ongedekt('join(import.meta.dir, "..", "bunfig.toml2")', alles)).toEqual(["bunfig.toml2"]);
    expect(ongedekt('new Glob("apps/*/src/*.ts")', alles)).toEqual(["apps/*/src/*.ts"]);
  });
  test("een anker in een submap lost .. correct op: join(import.meta.dir, '..', 'x') in scripts/lead is scripts/x", () => {
    expect(ongedekt('join(import.meta.dir, "..", "status.sh")', alles, join(SCRIPTS, "lead"))).toEqual([]);
    expect(ongedekt('join(import.meta.dir, "..", "..", "apps", "tmux")', alles, join(SCRIPTS, "lead"))).toEqual(["apps/tmux"]);
  });
  test("een pad dat al in de lijst staat of niet bestaat (fixture) geeft geen alarm", () => {
    expect(ongedekt('readFileSync(join(ROOT, "apps/goldcoast-api/src/a.ts"))', alles)).toEqual([]);
    expect(ongedekt('join(ROOT, "turbo.json")', alles)).toEqual([]);
    expect(ongedekt('join(ROOT, "apps/x/fixture.ts")', () => false)).toEqual([]);
    expect(ongedekt('new Glob("apps/*/turbo.json")', alles)).toEqual([]);
  });
  test("een los literal (functieargument, join(tmpdir, ...)) is data of een fixture en telt niet", () => {
    expect(ongedekt('isUnitTest("apps/tmux/test/e2e.ts"); join(dir, "apps/site/package.json")', alles)).toEqual([]);
    expect(ongedekt('"../scripts/lead/x.sh"', alles)).toEqual([]);
  });

  test("echt: elke bestaande scripts/**/*.test.ts wijst alleen paden aan die scripts-tests laten draaien", () => {
    const meldingen: string[] = [];
    for (const f of testBestanden(SCRIPTS)) {
      if (f === import.meta.path) continue; // dit bestand noemt zijn eigen fixture-paden
      for (const p of ongedekt(readFileSync(f, "utf8"), bestaatInRepo, dirname(f))) meldingen.push(`${f.slice(ROOT.length + 1)}: ${p}`);
    }
    expect(meldingen).toEqual([]);
  });
});
