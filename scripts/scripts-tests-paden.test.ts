// Bewaker voor de poortstap scripts-tests. Die slaat lokaal alleen over als elk gewijzigd bestand onder
// SCRIPTS_TESTS_VEILIG valt (scripts/scripts-tests-veilig.ts; scriptsTestsOverslaan in poort.ts). Dit bestand
// bewijst dat die allowlist klopt: geen bestand in scripts/ dat door scripts-tests draait of geïmporteerd wordt
// (tests en helpers, alle .ts/.js/.sh/.conf/.txt/.sjabloon; .md en .json zijn documentatie en data) noemt een pad
// onder de allowlist. Rood = dat pad kan een scripts-test breken terwijl de poort hem zou overslaan: haal het pad
// van de allowlist (of maak de test er onafhankelijk van).
//
// Detectie: een bewust simpele, conservatieve tekstscan van stringliteralen ("…", '…', `…`). Per veilig pad P
// (bijv. apps/goldcoast-klant, segment goldcoast-klant, pakketnaam @lab-bawuah/goldcoast-klant uit zijn package.json):
//  1. een literal die P noemt (ook als onderdeel van een langer pad of glob) en dat pad bestaat echt in de repo
//     en is door isVeilig() niet uitgezonderd (een niet-bestaand pad is een fixture, een uitgezonderd pad wordt
//     toch al niet overgeslagen);
//  2. een literal met de pakketnaam (ook `--filter=@lab-bawuah/x` of `@lab-bawuah/x/testing`);
//  3. een literal die het segment bevat (alleen bij een segment van 8+ tekens, zoals goldcoast-klant; een korte
//     naam als kort is exact te vaak een gewoon woord);
//  4. join-delen: "apps", "goldcoast-klant" naast elkaar, ook voor korte segmenten als kort.
// Een bestand dat de scan niet kan laten kloppen krijgt een VRIJSTELLING met reden (hieronder); die dekt dan het
// hele bestand, dus een nieuwe echte treffer daarin zien we niet.
//
// Vangt NIET: dynamisch opgebouwde namen (`apps/${naam}`, join(ROOT, "apps", app) met app uit een variabele,
// een naam uit een array of uit package.json); een korte segmentnaam (kort) los in een literal; de scanners die
// de hele repo lezen via git ls-files (ds-regels, echte-klok, werk-commentaar, test-tenant: hun tests draaien nu op
// fixtures; zodra een test dat op de echte repo doet, hoort dat pad van de allowlist); imports buiten scripts/ die
// zelf via een tussenpakket naar de veilige paden wijzen (bijv. packages/lab-commando importeert een veilig
// pakket, transitief buiten scripts/); bestanden buiten scripts/ die een scripts-test draait (bijv. een script in
// een ander pakket dat een scripts-test spawnt). Dat vangt alleen CI (`--ci`) of `--alles`.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isVeilig, SCRIPTS_TESTS_VEILIG } from "./scripts-tests-veilig";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPTS = join(ROOT, "scripts");

/** Bestanden waarin de scan een echte maar onschuldige treffer geeft, met de reden. Geen wildcard. */
export const VRIJSTELLING: Record<string, string> = {
  "scripts/vercel-ignore.test.ts":
    "bouwt een wegwerp-repo in tmp met een nep-pakket @lab-bawuah/goldcoast-klant; leest uit de echte repo alleen apps/site/scripts/vercel-ignore.sh (buiten de allowlist)",
};

type Doel = { pad: string; segment: string; pakket?: string };

/** De doelen uit een lijst veilige paden (met slot-/); de pakketnaam komt uit hun package.json. */
export function doelen(veilig: readonly string[] = SCRIPTS_TESTS_VEILIG, root = ROOT): Doel[] {
  return veilig.map((v) => {
    const pad = v.replace(/\/+$/, "");
    let pakket: string | undefined;
    try {
      pakket = JSON.parse(readFileSync(join(root, pad, "package.json"), "utf8")).name;
    } catch {}
    return { pad, segment: pad.split("/").pop() ?? pad, pakket };
  });
}

const LIT = String.raw`"[^"\n]*"|'[^'\n]*'|\x60[^\x60\n]*\x60`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Bestaat dit pad in de repo (bestand, map, of begin van een bestandsnaam)? */
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

/** Welke doelen noemt deze tekst (zie de kop voor de regels)? Lege lijst = schoon. */
export function treffers(
  tekst: string,
  lijst: Doel[],
  o: { bestaat?: (p: string) => boolean; veilig?: (p: string) => boolean; letterlijk?: boolean } = {},
): string[] {
  const bestaat = o.bestaat ?? bestaatInRepo;
  const veilig = o.veilig ?? isVeilig;
  // Een shellscript, conf of txt heeft geen betrouwbare literals: daar telt de hele tekst als één literal.
  const literals = o.letterlijk ? [tekst] : [...tekst.matchAll(new RegExp(LIT, "g"))].map((m) => m[0].slice(1, -1));
  const uit = new Set<string>();
  for (const d of lijst) {
    for (const l of literals) {
      for (const m of l.matchAll(new RegExp(`${esc(d.pad)}(?![\\w-])`, "g"))) {
        const token = /^[\w@.\-/*{}$[\]()]+/.exec(l.slice(m.index))?.[0] ?? d.pad;
        const glob = /[*{$]/.test(token);
        if (!glob && !bestaat(token.replace(/\/+$/, ""))) continue; // een fixture-pad dat niet bestaat
        if (!glob && !veilig(token)) continue; // uitgezonderd: wordt toch niet overgeslagen
        uit.add(`${d.pad}: pad in "${l.slice(0, 60)}"`);
      }
      if (d.pakket && l.includes(d.pakket)) uit.add(`${d.pad}: pakketnaam ${d.pakket}`);
      if (d.segment.length >= 8 && l.includes(d.segment) && !l.includes(d.pad)) uit.add(`${d.pad}: naam ${d.segment}`);
    }
    const delen = new RegExp(String.raw`(?:${LIT})\s*,\s*(?:${LIT})`, "g");
    const [map] = d.pad.split("/");
    for (const m of tekst.matchAll(delen)) {
      const [a, b] = m[0].split(/\s*,\s*/).map((x) => x.slice(1, -1));
      if (a === map && b === d.segment) uit.add(`${d.pad}: join-delen "${a}", "${b}"`);
    }
  }
  return [...uit];
}

const TEKST = /\.(ts|js|sh|conf|txt|sjabloon)$/;
function scriptBestanden(map: string): string[] {
  return readdirSync(map, { withFileTypes: true }).flatMap((e) => {
    const p = join(map, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : scriptBestanden(p);
    return TEKST.test(e.name) ? [p] : [];
  });
}

// Fixtures: een eigen lijst met een fictief pad, zodat de test niet van de echte allowlist afhangt.
const FIX: Doel[] = [
  { pad: "apps/mijn-klant", segment: "mijn-klant", pakket: "@lab-bawuah/mijn-klant" },
  { pad: "apps/kort", segment: "kort", pakket: "@lab-bawuah/kort" },
];
const bestaatAlles = () => true;
const alleVeilig = () => true;

describe("scripts-tests-paden: geen scripts-test noemt een pad onder SCRIPTS_TESTS_VEILIG", () => {
  const t = (tekst: string) => treffers(tekst, FIX, { bestaat: bestaatAlles, veilig: alleVeilig });
  test("negatief: een pad onder de allowlist, ook als deel van een langer pad of glob, is rood", () => {
    expect(t('readFileSync(join(ROOT, "apps/mijn-klant/src/a.ts"))')).toHaveLength(1);
    expect(t('new Glob("apps/mijn-klant/**/*.ts")')).toHaveLength(1);
    expect(t("const p = `apps/kort/${naam}`;")).toHaveLength(1);
  });
  test("negatief: via de pakketnaam is rood", () => {
    expect(t('import { x } from "@lab-bawuah/mijn-klant";')[0]).toContain("pakketnaam");
    expect(t('"--filter=@lab-bawuah/mijn-klant"').length).toBeGreaterThan(0);
    expect(t('import x from "@lab-bawuah/kort/lib"')[0]).toContain("pakketnaam");
  });
  test("negatief: via join-delen is rood (twee delen naast elkaar, of een lang segment los)", () => {
    expect(t('join(ROOT, "apps", "mijn-klant", "x.ts")').some((x) => x.includes("join-delen"))).toBe(true);
    expect(t('join(ROOT, "apps", "kort")').some((x) => x.includes("join-delen"))).toBe(true);
    expect(t('const naam = "mijn-klant";')[0]).toContain("naam mijn-klant");
  });
  test("negatief: een shellscript of conf (letterlijk) wordt ook gezien", () => {
    expect(treffers("cd apps/mijn-klant && bun test\n", FIX, { bestaat: bestaatAlles, veilig: alleVeilig, letterlijk: true })).toHaveLength(1);
  });
  test("geen alarm: een fixture-pad dat niet bestaat, een uitgezonderd pad, een kort woord, commentaar", () => {
    expect(treffers('"apps/mijn-klant/a.ts"', FIX, { bestaat: () => false, veilig: alleVeilig })).toEqual([]);
    expect(treffers('"apps/mijn-klant/vast.sh"', FIX, { bestaat: bestaatAlles, veilig: () => false })).toEqual([]);
    expect(t('const fase = "kort"; app: "kort"')).toEqual([]);
    expect(t("// leest apps/mijn-klant en @lab-bawuah/kort niet")).toEqual([]);
    expect(t('"apps/kortmap/a.ts"')).toEqual([]); // ander pad met dezelfde voorkant
  });
  test("de echte allowlist: elk pad bestaat in de repo en heeft een package.json met een naam", () => {
    for (const v of SCRIPTS_TESTS_VEILIG) {
      expect(v.endsWith("/")).toBe(true);
      expect(existsSync(join(ROOT, v))).toBe(true);
    }
    expect(doelen().map((d) => d.pakket)).not.toContain(undefined);
  });
  test("elke vrijstelling noemt een bestaand bestand en een reden", () => {
    for (const [f, reden] of Object.entries(VRIJSTELLING)) {
      expect(existsSync(join(ROOT, f))).toBe(true);
      expect(reden.length).toBeGreaterThan(20);
    }
  });

  test("echt: geen bestand in scripts/ noemt een pad onder de allowlist", () => {
    const lijst = doelen();
    const meldingen: string[] = [];
    for (const f of scriptBestanden(SCRIPTS)) {
      const rel = f.slice(ROOT.length + 1);
      if (f === import.meta.path || rel === "scripts/scripts-tests-veilig.ts" || rel in VRIJSTELLING) continue;
      for (const m of treffers(readFileSync(f, "utf8"), lijst, { letterlijk: !/\.(ts|js)$/.test(f) })) meldingen.push(`${rel}: ${m}`);
    }
    expect(meldingen).toEqual([]);
  });
});
