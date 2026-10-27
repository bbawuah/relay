// De poort vóór elke merge:  bun run poort   (snelle helft: bun run check)
//
// Eén script dat lokaal, in de pre-push-hook en later in CI hetzelfde doet
// (PLAN-kwaliteit §4, fase 1). Stappen, in deze volgorde:
//
// Vóór de stappen controleert de poort dat de repo niet bare is (core.bare=true, testlek 6 okt 2026); zo wel: FOUT met
// het herstelcommando, de poort herstelt niets zelf.
//
//   sherif      dependency-regels over alle package.json's      (hele repo)
//   boundaries  turbo boundaries: imports zonder dependency      (hele repo)
//   ds-regels   designsysteem-regels R1–R10 (scripts/ds-regels.ts) (alle apps)
//   werk-commentaar  TODO/HACK/FIXME/XXX/workaround alleen als TODO(JJJJ-MM-DD): reden; verlopen = FOUT
//   echte-klok  unittests wachten niet op de echte klok: Bun.sleep/setTimeout ≥ 10 ms = FOUT (scripts/echte-klok.ts)
//   test-tenant goldcoast-tests gebruiken geen vaste, gedeelde tenant-id: nieuweTestTenant() (scripts/test-tenant.ts)
//   mollie-sleutels geen Mollie-sleutel in de repo; live dicht zolang de globale sleutel in infra staat (scripts/mollie-sleutels.ts)
//   gc-data-laag  geen eigen fetch/maakClient in een useEffect of useState+useEffect-laadpatroon in apps/goldcoast-klant en -operatie: useQuery/useMutation (scripts/gc-data-laag.ts)
//   git-scrub   een testbestand dat git aanroept gebruikt een env zonder GIT_* (schoneEnv()); anders FOUT (scripts/git-scrub.ts)
//   test-integriteit  geen verwijderd testbestand, minder test(/it( of nieuwe .skip/.only/.todo zonder "// test-weg: reden" (scripts/test-integriteit.ts)
//   rood-op-basis  een fix (tak of PR-titel met "fix") brengt een unittest mee die op de basis faalt en op de tak slaagt (scripts/rood-op-basis.ts)
//   scripts-tests  bun test ./scripts/ (alleen overgeslagen als elk gewijzigd bestand onder SCRIPTS_TESTS_VEILIG valt, scripts/scripts-tests-veilig.ts; --alles, --ci, een lege diff en een git-fout draaien hem)
//   scripts-typen  tsc -p scripts/tsconfig.json (typecheck van scripts/, strict, types bun); draait alleen als scripts-tests draait (zelfde beslissing, dus zelfde SKIP); elke fout is FOUT, geen baseline
//   python-tests  python3 -m unittest per map onder tools/ met een test_*.py (tools/brein; < 1 s, altijd)
//   biome       biome ci: lint (alleen foutregels), geen format  (hele repo)
//   taken       turbo run lint typecheck test                    (affected; met POORT_DB_VERPLICHT=1 en docker als goldcoast-api/db affected, scripts/db-verplicht.ts)
//   build       turbo run build, zonder de site (zie baseline)   (affected)
//   e2e         turbo run e2e --concurrency=<POORT_E2E_CONCURRENCY> (affected; tmux, watchparty, storybook-axe)
//               met een machinebreed slot (scripts/e2e-slot.ts): standaard 2 runs tegelijk, POORT_E2E_SLOTS;
//               binnen een run 2 taken tegelijk, POORT_E2E_CONCURRENCY (1–4; 1 = de oude seriële run)
//
// sherif, boundaries en ds-regels vergelijken met scripts/poort-baseline.json:
// bekende schendingen zijn schuld, een nieuwe is FOUT, en een opgeloste die nog in
// de baseline staat ook (dan de regel weghalen, zodat de baseline alleen krimpt).
// ds-regels heeft daarnaast een allowlist met reden (UITZONDERINGEN in
// ds-regels.ts); een uitzondering die niets meer dekt is ook FOUT.
//
// Affected betekent: geraakt door de diff tussen de merge-base met --base en de
// werkkopie (ook niet-gecommitte wijzigingen). Standaard is de base `origin/main`
// (ook als je zelf op main staat: dan controleert de poort precies wat je gaat
// pushen); alleen zonder origin/main de lokale `main`. Een lokale main die
// achterloopt (de hoofdcheckout naast een worktree) bepaalt de base dus niet.
//
// Opties:
//   --alles          geen affected: alle workspaces
//   --zonder-e2e     de e2e-stap overslaan (= bun run check, de pre-push-hook)
//   --base <ref>     vergelijk met deze ref in plaats van origin/main
//   --ci             voor .github/workflows/ci.yml: sla de taken over die in
//                    uitzonderingen.ci van de baseline staan (alleen op de mini)
//   --alleen <s,…>   alleen deze stappen (sherif,boundaries,ds-regels,werk-commentaar,echte-klok,git-scrub,test-tenant,mollie-sleutels,gc-data-laag,test-integriteit,rood-op-basis,scripts-tests,scripts-typen,python-tests,biome,taken,build,e2e)
//   --zelftest       bewijs dat elke stap afkeurt: per stap een bewuste fout in een
//                    tijdelijke kopie van de werkkopie; de poort moet daar rood worden
//   --baseline       schrijf de huidige sherif-, boundaries- en ds-regels-schendingen naar de
//                    baseline (alleen bewust gebruiken; de diff hoort in review)
//
// Uitvoer: één regel per stap, OK / FOUT / SKIP, zoals rooktest.sh. Exitcode =
// aantal FOUT. Het stiltevenster (05:00–07:15) geldt voor de e2e-stap: daarin is
// e2e FOUT in plaats van stil overgeslagen; gebruik dan --zonder-e2e.
//
// Een groene volledige run (geen --ci) op een schone werkkopie, met dezelfde HEAD bij start en eind,
// laat een stempel achter in ~/.cache/lab-bawuah/poort/<sha>.json. scripts/lead/merge.sh eist zo'n stempel op de patch
// van de PR (geen merge zonder de geraakte e2e); later ook de uitrolscripts (besluit 10).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { aantalSlots, echteOmgeving, neemSlot, slotPrio } from "./e2e-slot";
import { ongebruikt, sleutels as dsSleutels, zoek as dsZoek } from "./ds-regels";
import { beschrijf as ekBeschrijf, nieuweTreffers as ekNieuw, OPLOSSING as EK_OPLOSSING, sleutel as ekSleutel, zoek as ekZoek } from "./echte-klok";
import { beschrijf as gdBeschrijf, nieuweTreffers as gdNieuw, OPLOSSING as GD_OPLOSSING, sleutel as gdSleutel, zoek as gdZoek } from "./gc-data-laag";
import { stapMollieSleutels } from "./mollie-sleutels";
import { beschrijf as ttBeschrijf, nieuweTreffers as ttNieuw, OPLOSSING as TT_OPLOSSING, sleutel as ttSleutel, zoek as ttZoek } from "./test-tenant";
import { beoordeelBare, beschrijf as gsBeschrijf, nieuweTreffers as gsNieuw, OPLOSSING as GS_OPLOSSING, sleutel as gsSleutel, zoek as gsZoek } from "./git-scrub";
import { leesPr } from "./bewijs-pr";
import { dockerBereikbaar, dockerOntbreekt, omgevingVoor, pakkettenVanTaken } from "./db-verplicht";
import { isVeilig, SCRIPTS_TESTS_VEILIG } from "./scripts-tests-veilig";
import { logCommando, openLog, zetActief } from "./poort-log";
import { inStiltevenster } from "./stiltevenster";
import { leesContext as roLees, stap as roStap } from "./rood-op-basis";
import { analyseer as tiAnalyseer } from "./test-integriteit";
import { JUISTE_VORM, sleutel as wcSleutel, zoek as wcZoek } from "./werk-commentaar";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PAD = path.join(ROOT, "scripts/poort-baseline.json");
const STAPPEN = ["sherif", "boundaries", "ds-regels", "werk-commentaar", "echte-klok", "git-scrub", "test-tenant", "mollie-sleutels", "gc-data-laag", "test-integriteit", "rood-op-basis", "scripts-tests", "scripts-typen", "python-tests", "biome", "taken", "build", "e2e"] as const;
type Stap = (typeof STAPPEN)[number];

// ── Opties ──────────────────────────────────────────────────────────────────

export type Opties = {
  alles: boolean;
  zonderE2e: boolean;
  base: string | null;
  alleen: Stap[] | null;
  zelftest: boolean;
  baseline: boolean;
  ci: boolean;
};

export function leesOpties(args: string[]): Opties {
  const o: Opties = { alles: false, zonderE2e: false, base: null, alleen: null, zelftest: false, baseline: false, ci: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue; // `bun run poort -- --alles`
    else if (a === "--alles") o.alles = true;
    else if (a === "--zonder-e2e") o.zonderE2e = true;
    else if (a === "--zelftest") o.zelftest = true;
    else if (a === "--baseline") o.baseline = true;
    else if (a === "--ci") o.ci = true;
    else if (a === "--base") {
      o.base = args[++i] ?? null;
      if (!o.base) throw new Error("--base vraagt een ref");
    } else if (a === "--alleen") {
      const lijst = (args[++i] ?? "").split(",").filter(Boolean);
      const fout = lijst.filter((s) => !(STAPPEN as readonly string[]).includes(s));
      if (!lijst.length || fout.length) throw new Error(`--alleen: kies uit ${STAPPEN.join(",")}`);
      o.alleen = lijst as Stap[];
    } else throw new Error(`onbekende optie: ${a}`);
  }
  return o;
}

// ── Hulp ────────────────────────────────────────────────────────────────────

/** `uit` = stdout en stderr samen (voor meldingen); `stdout` alleen stdout (voor JSON: turbo meldt waarschuwingen op stderr). */
export type Uitkomst = { code: number; uit: string; stdout: string };

export function draai(cmd: string[], env: Record<string, string> = {}, cwd = ROOT): Uitkomst {
  const p = Bun.spawnSync(cmd, {
    cwd,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), NO_COLOR: "1", FORCE_COLOR: "0", TURBO_TELEMETRY_DISABLED: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const kleurweg = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
  const stdout = kleurweg(p.stdout.toString());
  const uit = stdout + kleurweg(p.stderr.toString());
  logCommando(cmd, p.exitCode ?? 1, uit);
  return { code: p.exitCode ?? 1, uit, stdout };
}

/** De taken uit `turbo run … --dry=json`, alleen uit stdout; null als dat geen JSON is. */
export function leesDryTaken(stdout: string): { task: string; package: string; command: string }[] | null {
  try {
    const plan = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return Array.isArray(plan?.tasks) ? plan.tasks : null;
  } catch {
    return null;
  }
}

function git(...args: string[]): string {
  const r = draai(["git", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.uit.trim()}`);
  return r.uit.trim();
}

const bin = (naam: string) => path.join(ROOT, "node_modules/.bin", naam);

function staart(tekst: string, n = 40): string {
  return tekst.trimEnd().split("\n").slice(-n).map((r) => `     ${r}`).join("\n");
}

function duur(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

// Stiltevenster 05:00–07:15: één definitie in ./stiltevenster.
export { inStiltevenster };

// ── Baseline ────────────────────────────────────────────────────────────────

type Baseline = {
  _uitleg: string;
  sherif: string[];
  boundaries: string[];
  /** "bestand | regel-ID | regeltekst" (zie sleutel() in ds-regels.ts). */
  "ds-regels": string[];
  /** "bestand | regeltekst" van werk-commentaar in een ongeldige vorm (zie werk-commentaar.ts). */
  "werk-commentaar"?: string[];
  /** "bestand | regeltekst" van unittests die op de echte klok wachten (zie echte-klok.ts). */
  "echte-klok"?: string[];
  /** "bestand | regeltekst" van git-aanroepen in tests zonder env zonder GIT_* (zie git-scrub.ts). */
  "git-scrub"?: string[];
  /** "bestand | regeltekst" van vaste, gedeelde testtenant-id's in goldcoast-tests (zie test-tenant.ts). */
  "test-tenant"?: string[];
  /** "bestand | patroon" van eigen fetch-lagen in de Goldcoast-apps (zie gc-data-laag.ts). */
  "gc-data-laag"?: string[];
  uitzonderingen: {
    build: { zonder: string[]; reden: string; weg_als: string };
    /** `<package>#<taak>` die CI (--ci) niet draait; lokaal draaien ze wel. */
    ci?: { zonder: string[]; reden: string; weg_als: string };
  };
};

function leesBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PAD, "utf8"));
}

/** Multiset-verschil: wat nieuw is en wat uit de baseline verdwenen is. */
export function vergelijk(gevonden: string[], bekend: string[]): { nieuw: string[]; opgelost: string[] } {
  const rest = new Map<string, number>();
  for (const k of bekend) rest.set(k, (rest.get(k) ?? 0) + 1);
  const nieuw: string[] = [];
  for (const k of gevonden) {
    const n = rest.get(k) ?? 0;
    if (n > 0) rest.set(k, n - 1);
    else nieuw.push(k);
  }
  const opgelost = [...rest].flatMap(([k, n]) => Array<string>(n).fill(k));
  return { nieuw, opgelost };
}

/** sherif-uitvoer → sleutels "pad | regel | melding". */
export function sherifSleutels(uit: string): string[] {
  const sleutels: string[] = [];
  let pad = "?";
  for (const regel of uit.split("\n")) {
    const kop = regel.match(/issues? found in (\S+?):?$/);
    if (kop) pad = kop[1];
    const m = regel.match(/^\s*⨯ error (.*)\.\s+([a-z-]+)\s*$/);
    if (m) sleutels.push(`${pad} | ${m[2]} | ${m[1]}`);
  }
  return sleutels.sort();
}

/** turbo boundaries-uitvoer → sleutels "bestand | melding" (zonder regelnummer). */
export function boundarySleutels(uit: string, root = ROOT): string[] {
  const sleutels: string[] = [];
  let melding: string | null = null;
  for (const regel of uit.split("\n")) {
    const m = regel.match(/^\s*x (.+)$/);
    if (m) {
      melding = m[1].trim();
      continue;
    }
    const plek = regel.match(/,-\[(.+?):\d+:\d+\]/);
    if (plek && melding) {
      sleutels.push(`${path.relative(root, plek[1])} | ${melding}`);
      melding = null;
    }
  }
  return sleutels.sort();
}

// ── Stappen ─────────────────────────────────────────────────────────────────

export type Resultaat = { status: "OK" | "FOUT" | "SKIP"; detail?: string; uitleg?: string };

type BaselineSoort = "sherif" | "boundaries" | "ds-regels" | "werk-commentaar" | "echte-klok" | "git-scrub" | "test-tenant" | "gc-data-laag";

function metBaseline(soort: BaselineSoort, r: Uitkomst, sleutels: string[], extra: string[] = [], extraLabel = "allowlist verouderd", bekendUit?: string[]): Resultaat {
  const bekend = bekendUit ?? leesBaseline()[soort] ?? [];
  if (r.code !== 0 && sleutels.length === 0) {
    return { status: "FOUT", detail: "onverwachte uitvoer", uitleg: staart(r.uit) };
  }
  const { nieuw, opgelost } = vergelijk(sleutels, bekend);
  if (!nieuw.length && !opgelost.length && !extra.length) {
    return { status: "OK", detail: sleutels.length ? `${sleutels.length} bekend in baseline` : undefined };
  }
  const regels = [
    ...nieuw.map((k) => `     nieuw: ${k}`),
    ...opgelost.map((k) => `     opgelost, haal weg uit scripts/poort-baseline.json: ${k}`),
    ...extra.map((k) => `     ${k}`),
  ];
  const kop = [
    nieuw.length && `${nieuw.length} nieuw`,
    opgelost.length && `${opgelost.length} opgelost`,
    extra.length && `${extra.length} ${extraLabel}`,
  ]
    .filter(Boolean)
    .join(", ");
  const uitvoer = nieuw.length && r.uit ? `\n${staart(r.uit, 30)}` : "";
  return { status: "FOUT", detail: kop, uitleg: regels.join("\n") + uitvoer };
}

function stapSherif(): Resultaat {
  const r = draai([bin("sherif")]);
  return metBaseline("sherif", r, sherifSleutels(r.uit));
}

function stapBoundaries(): Resultaat {
  const r = draai([bin("turbo"), "boundaries"]);
  return metBaseline("boundaries", r, boundarySleutels(r.uit));
}

/**
 * ds-regels draait in-process over alle apps (geen affected: een paar honderd
 * bestanden lezen kost minder dan een seconde). Alleen treffers zonder
 * uitzondering tellen; een uitzondering die niets meer dekt is FOUT.
 */
function stapDsRegels(): Resultaat {
  const uitslagen = dsZoek();
  const treffers = uitslagen.flatMap((u) => u.treffers);
  const verouderd = ongebruikt(treffers).map((m) => `${m}; haal weg uit UITZONDERINGEN in scripts/ds-regels.ts`);
  const r = metBaseline("ds-regels", { code: 0, uit: "", stdout: "" }, dsSleutels(uitslagen), verouderd);
  const toegestaan = treffers.filter((t) => t.uitzondering).length;
  return r.status === "OK" ? { ...r, detail: `${r.detail ?? "0 in baseline"}, ${toegestaan} toegestaan` } : r;
}

/**
 * Werk-commentaar draait in-process over alle getrackte code (< 1 s). Een ongeldige
 * vorm vergelijkt met de baseline (mag alleen krimpen); een verlopen datum is altijd
 * FOUT. De foutmelding noemt de juiste vorm.
 */
function stapWerkCommentaar(): Resultaat {
  const treffers = wcZoek();
  const ongeldig = treffers.filter((t) => t.soort === "ongeldig").map(wcSleutel);
  const verlopen = treffers
    .filter((t) => t.soort === "verlopen")
    .map((t) => `verlopen (${t.datum}): ${t.bestand}:${t.regel}  ${t.tekst}; doe het werk, of zet een nieuwe datum met een reden`);
  const r = metBaseline("werk-commentaar", { code: 0, uit: "", stdout: "" }, ongeldig, verlopen, "verlopen");
  if (r.status === "FOUT") return { ...r, uitleg: `${r.uitleg}
     juiste vorm: ${JUISTE_VORM}` };
  return r;
}

/**
 * Echte klok draait in-process over alle getrackte unittests (< 1 s). Een nieuwe wachttijd
 * van 10 ms of meer is FOUT (bestaande in de baseline, mag alleen krimpen); de melding
 * noemt per treffer bestand, regel en tijd, en de oplossing.
 */
function stapEchteKlok(): Resultaat {
  const treffers = ekZoek();
  const r = metBaseline("echte-klok", { code: 0, uit: "", stdout: "" }, treffers.map(ekSleutel));
  if (r.status !== "FOUT") return r;
  const nieuw = ekNieuw(treffers, leesBaseline()["echte-klok"] ?? []).map((t) => `     ${ekBeschrijf(t)}`);
  return { ...r, uitleg: `${r.uitleg}${nieuw.length ? `\n${nieuw.join("\n")}` : ""}
     Op een trage runner wordt dat flaky; oplossing: ${EK_OPLOSSING}` };
}

/**
 * Git-scrub draait in-process over alle getrackte tests (< 1 s): een git-aanroep zonder env
 * zonder GIT_* is FOUT (bestaande in de baseline, mag alleen krimpen).
 */
function stapGitScrub(): Resultaat {
  const treffers = gsZoek();
  const r = metBaseline("git-scrub", { code: 0, uit: "", stdout: "" }, treffers.map(gsSleutel));
  if (r.status !== "FOUT") return r;
  const nieuw = gsNieuw(treffers, leesBaseline()["git-scrub"] ?? []).map((t) => `     ${gsBeschrijf(t)}`);
  return { ...r, uitleg: `${r.uitleg}${nieuw.length ? `\n${nieuw.join("\n")}` : ""}
     Oplossing: ${GS_OPLOSSING}` };
}

/**
 * Test-tenant draait in-process over de getrackte goldcoast-tests (< 1 s): een vaste, gedeelde
 * testtenant-id is FOUT (bestaande in de baseline, mag alleen krimpen).
 */
function stapTestTenant(): Resultaat {
  const treffers = ttZoek();
  const r = metBaseline("test-tenant", { code: 0, uit: "", stdout: "" }, treffers.map(ttSleutel));
  if (r.status !== "FOUT") return r;
  const nieuw = ttNieuw(treffers, leesBaseline()["test-tenant"] ?? []).map((t) => `     ${ttBeschrijf(t)}`);
  return { ...r, uitleg: `${r.uitleg}${nieuw.length ? `\n${nieuw.join("\n")}` : ""}
     Oplossing: ${TT_OPLOSSING}` };
}

/**
 * Gc-data-laag draait in-process over de getrackte bronbestanden van de Goldcoast-apps (< 1 s): een eigen
 * fetch-laag is FOUT (bestaande in de baseline, mag alleen krimpen).
 */
export function stapGcDataLaag(treffers = gdZoek(), bekendUit?: string[]): Resultaat {
  const bekend = bekendUit ?? leesBaseline()["gc-data-laag"] ?? [];
  const r = metBaseline("gc-data-laag", { code: 0, uit: "", stdout: "" }, treffers.map(gdSleutel), [], undefined, bekend);
  if (r.status !== "FOUT") return r;
  const nieuw = gdNieuw(treffers, bekend).map((t) => `     ${gdBeschrijf(t)}`);
  return { ...r, uitleg: `${r.uitleg}${nieuw.length ? `\n${nieuw.join("\n")}` : ""}
     Oplossing: ${GD_OPLOSSING}` };
}

/**
 * Test-integriteit draait in-process op de diff met de basis (merge-base): een verwijderd
 * testbestand, minder test(/it( of een nieuwe skip/only/todo is FOUT, tenzij met reden.
 * Redenen ("// test-weg: …") worden apart getoond, ook bij OK, voor de reviewer.
 */
function stapTestIntegriteit(base: string): Resultaat {
  const u = tiAnalyseer(base, { prBody: leesPr()?.body ?? null });
  const redenen = u.redenen.map((r) => `     reden voor de reviewer: ${r}`);
  if (u.fouten.length) {
    return { status: "FOUT", detail: `${u.fouten.length} testwijziging(en) zonder reden`, uitleg: [...u.fouten.map((f) => `     ${f}`), ...redenen].join("\n") };
  }
  return { status: "OK", detail: `${u.bestanden} testbestand(en) gewijzigd${redenen.length ? `, ${redenen.length} met reden` : ""}`, uitleg: redenen.join("\n") || undefined };
}

/** Rood op de basis: alleen voor een fix; draait de unittests van de fix tegen de merge-base (scripts/rood-op-basis.ts). */
function stapRoodOpBasis(base: string, ci: boolean): Resultaat {
  return roStap(base, roLees(), ROOT, ci);
}

/**
 * Pure beslissing: draaien de scripts-tests? Omgekeerd ontwerp (veilig falen): alleen SKIP als de diff met de
 * merge-base niet leeg is en ELK gewijzigd bestand onder SCRIPTS_TESTS_VEILIG valt (scripts/scripts-tests-veilig.ts).
 * Al het andere draait, ook een onbekend pad en een lege diff (een lege diff bewijst niets: veiliger draaien).
 * Altijd draaien bij --alles en --ci (CI is het vangnet). Geeft null (draaien) of de SKIP-reden.
 */
export function scriptsTestsOverslaan(o: Pick<Opties, "alles" | "ci">, gewijzigd: string[]): string | null {
  if (o.alles || o.ci) return null;
  if (gewijzigd.length === 0) return null;
  if (!gewijzigd.every(isVeilig)) return null;
  return `diff raakt alleen ${SCRIPTS_TESTS_VEILIG.join(", ")} (geen scripts-test leest die; elk ander pad laat hem draaien; --alles of --ci draait hem altijd)`;
}

/** Gewijzigde bestanden t.o.v. de merge-base: werkkopie (ook niet-gecommit) plus nieuwe, niet-getrackte bestanden. */
export function gewijzigdeBestanden(base: string, cwd = ROOT): string[] {
  // -z: NUL-gescheiden, zodat een pad met spaties of vreemde tekens (anders gequote) heel blijft.
  const lijst = (...a: string[]) => {
    const r = draai(["git", ...a], {}, cwd);
    if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.uit.trim()}`);
    return r.stdout.split("\0").filter(Boolean);
  };
  // --no-renames: een verplaatsing (scripts/a.test.ts naar elders) levert zo ook het oude pad op; anders ziet de diff alleen het nieuwe.
  return [...lijst("diff", "-z", "--name-only", "--no-renames", base), ...lijst("ls-files", "-z", "--others", "--exclude-standard")];
}

/** Wat stapScriptsTests van buiten nodig heeft; in tests vervangen door nepjes. */
export type ScriptsTestsDeps = { gewijzigd: (base: string) => string[]; draai: (cmd: string[]) => Uitkomst };

/**
 * De beslissing van scripts-tests, ook gebruikt door scripts-typen (die draait alleen als scripts-tests draait):
 * `reden` is de SKIP-reden of null (draaien), `noot` zegt dat de diff onleesbaar was en daarom gedraaid is.
 */
function scriptsBeslissing(o: Pick<Opties, "alles" | "ci">, base: () => string, d: ScriptsTestsDeps): { reden: string | null; noot: string } {
  let gewijzigd: string[] = [];
  let diffFout: string | null = null;
  if (!o.alles && !o.ci) {
    try {
      gewijzigd = d.gewijzigd(base());
    } catch (e) {
      diffFout = e instanceof Error ? e.message.split("\n")[0] ?? String(e) : String(e);
    }
  }
  return { reden: diffFout ? null : scriptsTestsOverslaan(o, gewijzigd), noot: diffFout ? ` (diff onleesbaar, dus gedraaid: ${diffFout})` : "" };
}

/**
 * De root is geen workspace, dus turbo draait deze tests niet; deze stap wel (draait tenzij de diff alleen onder SCRIPTS_TESTS_VEILIG ligt, zie scriptsTestsOverslaan; ~2-4 min).
 * `base` is lazy: bij --alles en --ci wordt noch de basis gekozen noch git aangeroepen.
 * Kan de diff niet gelezen worden (git faalt), dan draaien de tests (de veilige kant) en zegt de melding dat.
 */
export function stapScriptsTests(
  o: Pick<Opties, "alles" | "ci">,
  base: () => string,
  d: ScriptsTestsDeps = { gewijzigd: gewijzigdeBestanden, draai: (c) => draai(c) },
): Resultaat {
  const { reden, noot } = scriptsBeslissing(o, base, d);
  if (reden) return { status: "SKIP", detail: reden };
  const r = d.draai(["bun", "test", "./scripts/"]);
  const pass = r.uit.match(/^\s*(\d+) pass/m)?.[1];
  const fail = r.uit.match(/^\s*(\d+) fail/m)?.[1];
  if (r.code === 0) return { status: "OK", detail: pass ? `${pass} tests${noot}` : noot.trim() || undefined };
  return { status: "FOUT", detail: `${fail ? `${fail} mislukt` : "bun test faalde"}${noot}`, uitleg: staart(r.uit) };
}

/** Een regel van `tsc --pretty false`: `pad(regel,kolom): error TSnnnn: melding`. */
export type TscFout = { bestand: string; regel: number; code: string; melding: string };

/** tsc-uitvoer naar bestand:regel; vervolgregels (inspringing) horen bij de vorige melding en vallen weg. */
export function leesTscFouten(uit: string): TscFout[] {
  const fouten: TscFout[] = [];
  for (const l of uit.split("\n")) {
    const m = l.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/);
    if (m) fouten.push({ bestand: m[1]!, regel: Number(m[2]), code: m[3]!, melding: m[4]! });
  }
  return fouten;
}

/**
 * Typecheck van scripts/ (scripts/tsconfig.json, `types: ["bun"]`, strict). De root is geen workspace, dus turbo typecheckt
 * scripts/ niet (c0e23405 en c6bc75e7 brachten zo typefouten op main). Draait alleen als scripts-tests draait: dezelfde
 * beslissing (scriptsTestsOverslaan), dus SKIP met dezelfde reden; --alles en --ci altijd. Geen baseline: elke fout is FOUT.
 */
export function stapScriptsTypen(
  o: Pick<Opties, "alles" | "ci">,
  base: () => string,
  d: ScriptsTestsDeps & { tscAanwezig?: () => boolean } = { gewijzigd: gewijzigdeBestanden, draai: (c) => draai(c) },
): Resultaat {
  const { reden, noot } = scriptsBeslissing(o, base, d);
  if (reden) return { status: "SKIP", detail: reden };
  if (!(d.tscAanwezig ?? (() => existsSync(bin("tsc"))))()) {
    return { status: "FOUT", detail: "tsc ontbreekt, draai bun install", uitleg: `${bin("tsc")} bestaat niet; typescript is een devDependency van de root-package.json` };
  }
  const r = d.draai([bin("tsc"), "-p", "scripts/tsconfig.json", "--pretty", "false"]);
  const fouten = leesTscFouten(r.uit);
  if (r.code === 0 && !fouten.length) return { status: "OK", detail: noot.trim() || undefined };
  const lijst = fouten.slice(0, 20).map((f) => `     ${f.bestand}:${f.regel} ${f.code} ${f.melding}`).join("\n");
  const meer = fouten.length > 20 ? `\n     … en ${fouten.length - 20} meer` : "";
  if (!fouten.length) return { status: "FOUT", detail: `tsc faalde${noot}`, uitleg: staart(r.uit) };
  return { status: "FOUT", detail: `${fouten.length} typefout${fouten.length === 1 ? "" : "en"} in scripts/${noot}`, uitleg: lijst + meer };
}

/** Python buiten de workspaces (tools/brein): per map met een test_*.py (ook nog niet gecommit) één unittest-run, alleen stdlib. */
function stapPythonTests(): Resultaat {
  const mappen = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "tools/**/test_*.py").split("\n").filter(Boolean).map((f) => path.dirname(f)))];
  if (!mappen.length) return { status: "SKIP", detail: "geen test_*.py onder tools/" };
  let tests = 0;
  for (const map of mappen) {
    const r = draai(["python3", "-m", "unittest", "discover", "-s", map]);
    if (r.code !== 0) return { status: "FOUT", detail: `${map}: unittest faalde`, uitleg: staart(r.uit) };
    tests += Number(r.uit.match(/^Ran (\d+) tests?/m)?.[1] ?? 0);
  }
  return { status: "OK", detail: `${tests} tests in ${mappen.length} map(pen)` };
}

function stapBiome(): Resultaat {
  const r = draai([bin("biome"), "ci", "--colors=off", "--max-diagnostics=20", "."]);
  return r.code === 0 ? { status: "OK" } : { status: "FOUT", uitleg: staart(r.uit) };
}

export type Context = { affected: boolean; base: string | null; env: Record<string, string> };

function turbo(ctx: Context, taken: string[], extra: string[] = []): Uitkomst {
  const args = [bin("turbo"), "run", ...taken, "--output-logs=errors-only", "--ui=stream", ...extra];
  if (ctx.affected) args.push("--affected");
  return draai(args, ctx.env);
}

function turboResultaat(r: Uitkomst): Resultaat {
  const taken = r.uit.match(/Tasks:\s+(\d+) successful, (\d+) total/);
  const cache = r.uit.match(/Cached:\s+(\d+) cached/);
  const detail = taken ? `${taken[2]} taken, ${cache?.[1] ?? 0} uit cache` : "geen taken";
  if (r.code === 0) return { status: "OK", detail };
  const mislukt = r.uit.match(/Failed:\s+(.+)/)?.[1]?.trim();
  return { status: "FOUT", detail: mislukt ? `mislukt: ${mislukt}` : detail, uitleg: staart(r.uit) };
}

const TAKEN = ["lint", "typecheck", "test"];

/** `docker info` met tijdsgrens: bij een timeout killt Bun het proces en is de exitcode null. */
const dockerInfo = (timeout: number) => {
  const p = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], { stdout: "ignore", stderr: "ignore", timeout });
  return { code: p.exitCode };
};

/** De packages met een (affected) test-taak; null als dat niet te bepalen is of alles draait. */
function testPakketten(ctx: Context): string[] | null {
  if (!ctx.affected) return null;
  const dry = turbo(ctx, ["test"], ["--dry=json"]);
  return pakkettenVanTaken(dry.code === 0 ? leesDryTaken(dry.stdout) : null, "test");
}

function stapTaken(basis: Context, ci: boolean): Resultaat {
  // DB-integratietests mogen niet stil overslaan (scripts/db-verplicht.ts): affected goldcoast-api/db eist docker.
  const { env, verplicht } = omgevingVoor(basis.env, testPakketten(basis), new Date());
  const geenDocker = dockerOntbreekt(verplicht, !verplicht || dockerBereikbaar(dockerInfo));
  if (geenDocker) return { status: "FOUT", detail: "geen docker", uitleg: `     ${geenDocker}` };
  const ctx: Context = { ...basis, env };
  const zonder = ci ? (leesBaseline().uitzonderingen.ci?.zonder ?? []) : [];
  if (!zonder.length) return turboResultaat(turbo(ctx, TAKEN));
  // Een package met een uitgezonderde taak gaat uit de gewone run en krijgt een
  // eigen run met de taken die overblijven.
  const perPackage = new Map<string, string[]>();
  for (const z of zonder) {
    const [pkg, taak] = z.split("#");
    perPackage.set(pkg!, [...(perPackage.get(pkg!) ?? []), taak!]);
  }
  const runs = [turboResultaat(turbo(ctx, TAKEN, [...perPackage.keys()].map((p) => `--filter=!${p}`)))];
  for (const [pkg, weg] of perPackage) {
    const rest = TAKEN.filter((t) => !weg.includes(t));
    if (rest.length) runs.push(turboResultaat(turbo(ctx, rest, [`--filter=${pkg}`])));
  }
  const fout = runs.find((r) => r.status === "FOUT");
  const detail = `${runs.map((r) => r.detail).join(" + ")}; zonder ${zonder.join(", ")} (CI)`;
  return fout ? { ...fout, detail: `${fout.detail}; zonder ${zonder.join(", ")} (CI)` } : { status: "OK", detail };
}

function stapBuild(ctx: Context): Resultaat {
  const zonder = leesBaseline().uitzonderingen.build.zonder;
  return turboResultaat(turbo(ctx, ["build"], zonder.map((p) => `--filter=!${p}`)));
}

/** Wat stapE2e van buiten haalt; de test vervangt ze (nep-klok, nep-turbo, nep-slot). */
export type E2eAfhankelijk = {
  nu?: () => Date;
  turbo?: (ctx: Context, taken: string[], extra?: string[]) => Uitkomst;
  neemSlot?: () => Promise<{ vrij(): void }>;
  dockerInfo?: (timeout: number) => { code: number | null };
  env?: Record<string, string | undefined>;
};

/**
 * Taken tegelijk binnen één e2e-run: POORT_E2E_CONCURRENCY, een geheel getal 1–4, standaard 2.
 * De suites delen binnen een run niets (eigen vrije poorten, tmux-socket per pid, watchparty-poort
 * en -dist per run, testcontainer per pid). Een andere waarde is een fout, geen stille terugval.
 */
export function e2eConcurrency(env: Record<string, string | undefined>): number {
  const w = env.POORT_E2E_CONCURRENCY;
  if (w === undefined || w === "") return 2;
  if (!/^[1-4]$/.test(w)) throw new Error(`POORT_E2E_CONCURRENCY=${JSON.stringify(w)}: verwacht een geheel getal van 1 tot en met 4 (1 = serieel)`);
  return Number(w);
}

// Stiltevenster en cache: de venstercheck staat hier VÓÓR de `turbo run e2e` (alleen de --dry=json
// ervoor, die niets draait). Zo geeft een cachehit in het venster nooit een groene e2e-stap, en een
// e2e die in het venster wél draait en weigert, faalt en wordt door turbo niet gecachet.
export async function stapE2e(ctx: Context, dep: E2eAfhankelijk = {}): Promise<Resultaat> {
  const draaiTurbo = dep.turbo ?? turbo;
  let concurrency: number;
  try {
    concurrency = e2eConcurrency(dep.env ?? process.env);
  } catch (e) {
    return { status: "FOUT", detail: (e as Error).message };
  }
  const dry = draaiTurbo(ctx, ["e2e"], ["--dry=json"]);
  if (dry.code !== 0) return { status: "FOUT", detail: "turbo --dry faalde", uitleg: staart(dry.uit) };
  // Alleen stdout: turbo meldt waarschuwingen (remote cache niet beschikbaar, 403) op stderr.
  const taken = leesDryTaken(dry.stdout);
  if (!taken) return { status: "FOUT", detail: "turbo --dry gaf geen JSON", uitleg: staart(dry.uit) };
  const e2e = taken
    .filter((t) => t.task === "e2e" && t.command !== "<NONEXISTENT>")
    .map((t) => t.package);
  if (!e2e.length) return { status: "SKIP", detail: "geen e2e geraakt" };
  const nu = dep.nu ?? (() => new Date());
  const venster = (wanneer: string): Resultaat => ({ status: "FOUT", detail: `stiltevenster 05:00–07:15 ${wanneer}, e2e van ${e2e.join(", ")} niet gedraaid of niet geldig; na 07:15 opnieuw, of --zonder-e2e` });
  if (inStiltevenster(nu())) return venster("(voor het slot)");
  // Maximaal POORT_E2E_SLOTS (standaard 2) volledige e2e-runs tegelijk op de machine;
  // binnen een run POORT_E2E_CONCURRENCY (standaard 2) taken tegelijk.
  let slot: { vrij(): void };
  try {
    slot = await (dep.neemSlot ?? (() => neemSlot(echteOmgeving(process.cwd()), aantalSlots(), undefined, slotPrio())))();
  } catch (e) {
    return { status: "FOUT", detail: (e as Error).message };
  }
  const vrij = () => slot.vrij();
  process.on("exit", vrij);
  try {
    // Het slot kan lang wachten: het venster kan intussen begonnen zijn. Opnieuw toetsen vóór de run,
    // en na de run (begon het venster tijdens de run, dan geldt de uitslag niet).
    if (inStiltevenster(nu())) return venster("(begonnen tijdens het wachten op een slot)");
    // cross-tenant (goldcoast-api) draait in de e2e-taak: ook daar eist de poort docker (scripts/db-verplicht.ts).
    const { env, verplicht } = omgevingVoor(ctx.env, e2e, nu());
    const geenDocker = dockerOntbreekt(verplicht, !verplicht || dockerBereikbaar(dep.dockerInfo ?? dockerInfo));
    if (geenDocker) return { status: "FOUT", detail: "geen docker", uitleg: `     ${geenDocker}` };
    // --cache=local:rw: e2e-uitslagen gaan nooit via de remote cache (remoteCache in turbo.json) naar of van een andere machine.
    const r = turboResultaat(draaiTurbo({ ...ctx, env }, ["e2e"], [`--concurrency=${concurrency}`, "--cache=local:rw"]));
    if (inStiltevenster(nu())) return venster("(begonnen tijdens de run)");
    return { ...r, detail: `${e2e.join(", ")}: ${r.detail}` };
  } finally {
    vrij();
    process.off("exit", vrij);
  }
}

// ── Base ────────────────────────────────────────────────────────────────────

/**
 * De base voor affected: `--base` als die gegeven is, anders origin/main als die bestaat, anders de
 * lokale main. Niet de lokale main als origin/main er is: in een worktree loopt die vaak achter (de
 * hoofdcheckout wordt niet bijgewerkt), en dan telt alles wat sindsdien op main kwam als gewijzigd.
 */
export function kiesBase(gevraagd: string | null, cwd = ROOT): { ref: string; sha: string } {
  let ref = gevraagd ?? "main";
  if (!gevraagd && draai(["git", "rev-parse", "--verify", "-q", "origin/main^{commit}"], {}, cwd).uit.trim()) ref = "origin/main";
  const r = draai(["git", "merge-base", ref, "HEAD"], {}, cwd);
  if (r.code !== 0) throw new Error(`git merge-base ${ref} HEAD: ${r.uit.trim()}`);
  return { ref, sha: r.uit.trim() };
}

// ── Poort ───────────────────────────────────────────────────────────────────

/** Preflight vóór de stappen: de repo mag niet bare zijn. Geeft de FOUT-tekst of null (zie beoordeelBare). */
export function controleerNietBare(): string | null {
  const isBare = draai(["git", "rev-parse", "--is-bare-repository"]).uit;
  const config = draai(["git", "config", "--local", "core.bare"]).uit;
  const dir = draai(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return beoordeelBare(isBare, config, dir.code === 0 && dir.uit.trim() ? dir.uit.trim() : "<.git-pad>");
}

async function poort(o: Opties): Promise<number> {
  const bare = controleerNietBare();
  if (bare) {
    console.log(`FOUT preflight      ${bare}`);
    console.log("poort: 1 FOUT (niets gedraaid; de poort herstelt de repo niet zelf)");
    return 1;
  }
  const stappen = (o.alleen ?? [...STAPPEN]).filter((s) => !(o.zonderE2e && s === "e2e"));
  const ctx: Context = { affected: !o.alles, base: null, env: {} };
  // Logbestand met de volledige uitvoer (scripts/poort-log.ts); een fout hier laat de poort niet falen.
  const logMap = draai(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const log = openLog({
    map: path.join(logMap.code === 0 ? logMap.stdout.trim() : path.join(ROOT, ".git"), "lab-poort"),
    sha: draai(["git", "rev-parse", "HEAD"]).stdout.trim() || "0000000",
    pad: process.env.POORT_LOGPAD || undefined,
  });
  zetActief(log);
  const uit = (tekst: string) => {
    console.log(tekst);
    log.regel(tekst);
  };
  log.regel(`poort-start: args=${JSON.stringify(process.argv.slice(2))} modus=${o.alles ? "alles" : "affected"} base=${o.base ?? "origin/main"}`);
  if (!o.alles) {
    const base = kiesBase(o.base);
    ctx.base = base.sha;
    ctx.env = { TURBO_SCM_BASE: base.sha, TURBO_SCM_HEAD: "HEAD" };
    uit(`poort: affected t.o.v. ${base.ref} (merge-base ${base.sha.slice(0, 9)})`);
  } else uit("poort: alles");

  const stapBase = () => ctx.base ?? kiesBase(o.base).sha;
  // HEAD en schoon-zijn bij de start: de stempel hoort bij wat getest is, niet bij wat er aan het eind staat
  const start = { sha: git("rev-parse", "HEAD"), schoon: git("status", "--porcelain") === "" };
  const begin = Date.now();
  let fouten = 0;
  const overgeslagen: Stap[] = [];
  for (const s of STAPPEN) {
    if (!stappen.includes(s)) {
      if (s === "e2e" && o.zonderE2e) uit("SKIP e2e            --zonder-e2e");
      continue;
    }
    const t0 = Date.now();
    log.stapStart(s);
    const r =
      s === "sherif" ? stapSherif()
      : s === "boundaries" ? stapBoundaries()
      : s === "ds-regels" ? stapDsRegels()
      : s === "werk-commentaar" ? stapWerkCommentaar()
      : s === "echte-klok" ? stapEchteKlok()
      : s === "git-scrub" ? stapGitScrub()
      : s === "test-tenant" ? stapTestTenant()
      : s === "mollie-sleutels" ? stapMollieSleutels()
      : s === "gc-data-laag" ? stapGcDataLaag()
      : s === "test-integriteit" ? stapTestIntegriteit(stapBase())
      : s === "rood-op-basis" ? stapRoodOpBasis(stapBase(), o.ci)
      : s === "scripts-tests" ? stapScriptsTests(o, stapBase)
      : s === "scripts-typen" ? stapScriptsTypen(o, stapBase)
      : s === "python-tests" ? stapPythonTests()
      : s === "biome" ? stapBiome()
      : s === "taken" ? stapTaken(ctx, o.ci)
      : s === "build" ? stapBuild(ctx)
      : await stapE2e(ctx);
    if (r.status === "FOUT") fouten++;
    if (r.status === "SKIP") overgeslagen.push(s);
    const tijd = r.status === "SKIP" ? "" : ` (${duur(Date.now() - t0)})`;
    log.stapEind(s, r.status, Date.now() - t0, r.detail, r.status === "SKIP" ? undefined : r.uitleg);
    console.log(`${r.status.padEnd(4)} ${s.padEnd(14)}${r.detail ? ` ${r.detail}` : ""}${tijd}`);
    if (r.uitleg && r.status !== "SKIP") console.log(r.uitleg);
  }
  uit(`poort: ${fouten ? `${fouten} FOUT` : "groen"} in ${duur(Date.now() - begin)}`);

  const eind = { sha: git("rev-parse", "HEAD"), schoon: git("status", "--porcelain") === "" };
  const waarom = geenStempel(fouten, o, start, eind);
  if (waarom) console.log(`poort: geen stempel (${waarom})`);
  else {
    const sha = start.sha;
    const fout = schrijfStempel(path.join(homedir(), ".cache/lab-bawuah/poort"), {
      sha,
      groen: true,
      modus: o.alles ? "alles" : "affected",
      base: ctx.base,
      tijd: new Date().toISOString(),
      ...stempelOvergeslagen(overgeslagen),
    });
    if (fout) console.log(geenStempelMelding(fout));
  }
  zetActief(null);
  // De laatste regel van een rode poort is het pad (de pre-push-hook geeft zelf een POORT_LOGPAD mee en noemt dat pad).
  if (log.pad) console.log(fouten ? `poort: rood, volledige uitvoer: ${log.pad}` : `poort: volledige uitvoer: ${log.pad}`);
  return fouten;
}

/** Schrijft <map>/<sha>.json; geeft de fout terug in plaats van te gooien (in de agent-sandbox is
 * de map niet schrijfbaar, en dan mag een groene poort niet crashen). */
export function schrijfStempel(map: string, stempel: { sha: string } & Record<string, unknown>): string | null {
  try {
    mkdirSync(map, { recursive: true });
    writeFileSync(path.join(map, `${stempel.sha}.json`), `${JSON.stringify(stempel)}\n`);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Optioneel stempelveld `overgeslagen`: stappen die in deze groene run SKIP waren omdat de diff ze niet
 * raakte (nu alleen scripts-tests), zodat de lead bij een merge ziet wat niet gedraaid is. Een run
 * zonder zo'n skip schrijft het veld niet; merge.sh leest alleen sha/groen/modus/base/tijd, dus het
 * formaat blijft compatibel.
 */
export function stempelOvergeslagen(skips: readonly string[]): { overgeslagen?: string[] } {
  const lijst = skips.filter((s) => s === "scripts-tests" || s === "scripts-typen");
  return lijst.length ? { overgeslagen: lijst } : {};
}

/** Luid: de poort is groen, maar zonder stempel weigert merge.sh deze tak. */
export const geenStempelMelding = (fout: string) =>
  `LET OP poort: groen, maar GEEN stempel geschreven (${fout}). merge.sh weigert deze tak tot er een stempel is.`;

/** Waarom deze run geen stempel krijgt, of null: alleen een volledige, groene run (geen --ci, die
 * taken overslaat) op een werkkopie die bij de start én het eind schoon is, op dezelfde HEAD. */
export function geenStempel(
  fouten: number,
  o: Pick<Opties, "alleen" | "zonderE2e" | "ci">,
  start: { sha: string; schoon: boolean },
  eind: { sha: string; schoon: boolean },
): string | null {
  if (fouten) return "niet groen";
  if (o.alleen || o.zonderE2e) return "niet volledig";
  if (o.ci) return "--ci slaat taken over";
  if (!start.schoon || !eind.schoon) return "werkkopie niet schoon";
  if (start.sha !== eind.sha) return `HEAD veranderde tijdens de run (${start.sha.slice(0, 7)} → ${eind.sha.slice(0, 7)})`;
  return null;
}

// ── Baseline schrijven ──────────────────────────────────────────────────────

function schrijfBaseline(): void {
  const b = leesBaseline();
  b.sherif = sherifSleutels(draai([bin("sherif")]).uit);
  b.boundaries = boundarySleutels(draai([bin("turbo"), "boundaries"]).uit);
  b["ds-regels"] = dsSleutels(dsZoek());
  b["werk-commentaar"] = wcZoek()
    .filter((t) => t.soort === "ongeldig")
    .map(wcSleutel)
    .sort();
  b["echte-klok"] = ekZoek().map(ekSleutel).sort();
  b["git-scrub"] = gsZoek().map(gsSleutel).sort();
  b["test-tenant"] = ttZoek().map(ttSleutel).sort();
  b["gc-data-laag"] = gdZoek().map(gdSleutel).sort();
  writeFileSync(BASELINE_PAD, JSON.stringify(b, null, 2) + "\n");
  console.log(
    `baseline: ${b.sherif.length} sherif, ${b.boundaries.length} boundaries, ${b["ds-regels"].length} ds-regels, ${b["werk-commentaar"].length} werk-commentaar, ${b["echte-klok"].length} echte-klok, ${b["git-scrub"].length} git-scrub, ${b["test-tenant"].length} test-tenant, ${b["gc-data-laag"].length} gc-data-laag → scripts/poort-baseline.json`,
  );
}

// ── Zelftest ────────────────────────────────────────────────────────────────

type Kanarie = { stap: Stap; wat: string; verwacht: RegExp; zet: (map: string) => void; env?: Record<string, string> };

const schrijf = (map: string, pad: string, inhoud: string) => {
  mkdirSync(path.dirname(path.join(map, pad)), { recursive: true });
  writeFileSync(path.join(map, pad), inhoud);
};
const pasPkgAan = (map: string, pad: string, f: (pkg: Record<string, any>) => void) => {
  const p = path.join(map, pad);
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  f(pkg);
  writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
};

// Elke kanarie zit in een blad van de graaf (template of site), zodat affected
// alleen die app raakt en de zelftest snel blijft.
export const KANARIES: Kanarie[] = [
  {
    stap: "sherif",
    wat: "afwijkende typescript-versie in apps/template",
    verwacht: /FOUT sherif .*1 nieuw/,
    zet: (m) => pasPkgAan(m, "apps/template/package.json", (p) => (p.devDependencies.typescript = "4.9.5")),
  },
  {
    stap: "boundaries",
    wat: "import van een niet-gedeclareerde dependency (zod) in apps/template",
    verwacht: /FOUT boundaries .*1 nieuw/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-boundaries.ts", 'import { z } from "zod";\nexport const kanarie = z.string();\n'),
  },
  {
    stap: "ds-regels",
    wat: "een nieuwe rounded-3xl in apps/template (R3)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-ds-radius.tsx", 'export const Kanarie = () => <div className="rounded-3xl" />;\n'),
  },
  {
    stap: "ds-regels",
    wat: "een nieuwe <Card> zonder variant in apps/template (R1)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) =>
      schrijf(
        m,
        "apps/template/src/kanarie-ds-card.tsx",
        'import { Card } from "@lab-bawuah/components-react";\nexport const Kanarie = () => <Card>kanarie</Card>;\n',
      ),
  },
  {
    stap: "ds-regels",
    wat: "een niet-zwevende schaduw in apps/site/components/chat/chat-ui.tsx (bestand op de allowlist zwevend, R4)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) =>
      schrijf(
        m,
        "apps/site/components/chat/chat-ui.tsx",
        `${readFileSync(path.join(m, "apps/site/components/chat/chat-ui.tsx"), "utf8")}export const KanarieSchaduw = () => <div className="p-4 shadow-md" />;\n`,
      ),
  },
  {
    stap: "ds-regels",
    wat: "een .mdx met een echte <Card> naast `rounded-3xl` als inline code (alleen de JSX telt)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) =>
      schrijf(
        m,
        "apps/template/src/kanarie-ds.mdx",
        "Zo niet: `rounded-3xl` of `<Card>` als sectie.\n\n```tsx\n<Card className=\"rounded-3xl\" />\n```\n\n<Card>kanarie</Card>\n",
      ),
  },
  {
    stap: "ds-regels",
    wat: "een Tailwind-paletkleur met variant in apps/template (R8)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-ds-palet.tsx", 'export const Kanarie = () => <p className="hover:text-red-500/80">kanarie</p>;\n'),
  },
  {
    stap: "ds-regels",
    wat: "een hex-kleur in de opmaak van apps/template (R9)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-ds-hex.tsx", 'export const Kanarie = () => <p style={{ color: "#1B2A4E" }}>kanarie</p>;\n'),
  },
  {
    stap: "ds-regels",
    wat: "een rekenmaat op de spacing-eenheid in apps/template (R10 omweg-maat; R5 ziet die niet)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) =>
      schrijf(m, "apps/template/src/kanarie-ds-omweg.tsx", 'export const Kanarie = () => <p className="text-[calc(var(--spacing)*6.5)]">kanarie</p>;\n'),
  },
  {
    stap: "ds-regels",
    wat: "een inline fontSize in px/rem/em of als getal in apps/template (R10 omweg-maat, inline style)",
    verwacht: /FOUT ds-regels .*1 nieuw/,
    zet: (m) =>
      schrijf(m, "apps/template/src/kanarie-ds-inline.tsx", 'export const Kanarie = () => <p style={{ fontSize: "0.8125rem" }}>kanarie</p>;\n'),
  },
  {
    stap: "ds-regels",
    wat: "een opgeloste treffer die nog in de baseline staat",
    verwacht: /FOUT ds-regels .*1 opgelost/,
    zet: (m) =>
      pasPkgAan(m, "scripts/poort-baseline.json", (b) => b["ds-regels"].push("apps/template/src/bestaat-niet.tsx | R3 | rounded-3xl")),
  },
  {
    stap: "werk-commentaar",
    wat: "een kale TODO zonder datum in apps/template",
    verwacht: /FOUT werk-commentaar .*1 nieuw/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-werk.ts", "// TODO: dit later netjes maken\nexport const kanarie = 1;\n"),
  },
  {
    stap: "werk-commentaar",
    wat: "een TODO met een verlopen datum in apps/template",
    verwacht: /FOUT werk-commentaar .*1 verlopen/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-werk-verlopen.ts", "// TODO(2020-01-01): oude afspraak\nexport const kanarie = 1;\n"),
  },
  {
    stap: "echte-klok",
    wat: "een unittest met Bun.sleep(50) in apps/template",
    verwacht: /FOUT echte-klok .*1 nieuw/,
    zet: (m) =>
      schrijf(
        m,
        "apps/template/src/kanarie-klok.test.ts",
        'import { expect, test } from "bun:test";\ntest("kanarie", async () => {\n  await Bun.sleep(50);\n  expect(1).toBe(1);\n});\n',
      ),
  },
  {
    stap: "echte-klok",
    wat: "de echte oude test van #52: paneel.test.tsx van 9fe29d5^ (Bun.sleep(70) en (60))",
    verwacht: /FOUT echte-klok .*2 nieuw/,
    zet: (m) => schrijf(m, "apps/watchparty/src/ui/paneel.test.tsx", git("show", "9fe29d5^:apps/watchparty/src/ui/paneel.test.tsx") + "\n"),
  },
  {
    stap: "test-tenant",
    wat: "een goldcoast-test met een vaste tenant-id (fixture) in apps/goldcoast-api",
    verwacht: /FOUT test-tenant .*1 nieuw/,
    zet: (m) =>
      schrijf(
        m,
        "apps/goldcoast-api/src/kanarie-tenant.test.ts",
        'import { expect, test } from "bun:test";\nconst TENANT = "11111111-1111-4111-8111-111111111111";\ntest("kanarie", () => {\n  expect(TENANT).toBeString();\n});\n',
      ),
  },
  {
    stap: "mollie-sleutels",
    wat: "een nep-live_-sleutel in een fixture-bestand van apps/template",
    verwacht: /FOUT mollie-sleutels .*1 treffer/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-mollie.ts", `export const k = "${"live"}_${"Nep".padEnd(24, "x")}";\n`),
  },
  {
    stap: "mollie-sleutels",
    wat: "de ^test_-regel op MOLLIE_API_KEY in kern/config.ts versoepeld (toets 2, zolang infra de globale sleutel noemt)",
    verwacht: /FOUT mollie-sleutels .*1 treffer/,
    zet: (m) => {
      const p = "apps/goldcoast-api/src/kern/config.ts";
      const oud = readFileSync(path.join(m, p), "utf8");
      const nieuw = oud.replace(/MOLLIE_API_KEY: z\.string\(\)\.regex\(\/\^test_[^)]*\)/, "MOLLIE_API_KEY: z.string()");
      if (nieuw === oud) throw new Error("kanarie mollie-sleutels: de ^test_-regel staat niet in " + p);
      schrijf(m, p, nieuw);
    },
  },
  {
    stap: "gc-data-laag",
    wat: "een useEffect met maakClient( in een fixture-bestand van de klant-app",
    verwacht: /FOUT gc-data-laag .*1 nieuw/,
    zet: (m) =>
      schrijf(
        m,
        "apps/goldcoast-klant/components/kanarie-data.tsx",
        'import { useEffect } from "react";\nexport function Kanarie() {\n  useEffect(() => {\n    maakClient();\n  }, []);\n  return null;\n}\n',
      ),
  },
  {
    stap: "git-scrub",
    wat: "een test die git aanroept met env: process.env in apps/template",
    verwacht: /FOUT git-scrub .*1 nieuw/,
    zet: (m) =>
      schrijf(
        m,
        "apps/template/src/kanarie-git.test.ts",
        'import { expect, test } from "bun:test";\ntest("kanarie", () => {\n  Bun.spawnSync(["git", "status"], { env: process.env });\n  expect(1).toBe(1);\n});\n',
      ),
  },
  {
    stap: "test-integriteit",
    wat: "een verwijderd testbestand (scripts/werk-commentaar.test.ts)",
    verwacht: /FOUT test-integriteit .*1 testwijziging/,
    zet: (m) => rmSync(path.join(m, "scripts/werk-commentaar.test.ts")),
  },
  {
    stap: "test-integriteit",
    wat: "minder test(/it( in een bestaand testbestand (scripts/echte-klok.test.ts)",
    verwacht: /FOUT test-integriteit .*1 testwijziging/,
    zet: (m) => {
      const p = path.join(m, "scripts/echte-klok.test.ts");
      writeFileSync(p, readFileSync(p, "utf8").replace("test(", "bewaar("));
    },
  },
  {
    stap: "test-integriteit",
    wat: "een testbestand hernoemd naar buiten het testpatroon (scripts/werk-commentaar.test.ts → .ts)",
    verwacht: /FOUT test-integriteit .*1 testwijziging/,
    zet: (m) => renameSync(path.join(m, "scripts/werk-commentaar.test.ts"), path.join(m, "scripts/werk-commentaar-oud.ts")),
  },
  {
    stap: "test-integriteit",
    wat: "een nieuwe test.skip zonder reden",
    verwacht: /FOUT test-integriteit .*1 testwijziging/,
    zet: (m) => {
      const p = path.join(m, "scripts/echte-klok.test.ts");
      writeFileSync(p, `${readFileSync(p, "utf8")}\ntest.skip("kanarie", () => {});\n`);
    },
  },
  {
    stap: "rood-op-basis",
    wat: 'een fix ("fix: kanarie") zonder nieuwe of gewijzigde test',
    verwacht: /FOUT rood-op-basis .*fix zonder/,
    env: { PR_TITEL: "fix: kanarie" },
    zet: (m) => schrijf(m, "apps/template/src/kanarie-fix.ts", "export const kanarie = 1;\n"),
  },
  {
    stap: "rood-op-basis",
    wat: 'een fix ("fix: kanarie") met een test die ook op de basis slaagt',
    verwacht: /FOUT rood-op-basis .*slaagt ook op de basis/,
    env: { PR_TITEL: "fix: kanarie" },
    zet: (m) => {
      schrijf(m, "apps/template/src/kanarie-fix.ts", "export const kanarie = 1;\n");
      schrijf(m, "apps/template/src/kanarie-fix.test.ts", 'import { expect, test } from "bun:test";\ntest("kanarie", () => expect(1).toBe(1));\n');
    },
  },
  {
    stap: "scripts-tests",
    wat: "falende test in scripts/",
    verwacht: /FOUT scripts-tests .*\b1 mislukt/,
    zet: (m) => schrijf(m, "scripts/kanarie.test.ts", 'import { expect, test } from "bun:test";\ntest("kanarie", () => expect(1).toBe(2));\n'),
  },
  {
    stap: "scripts-typen",
    wat: "typefout in scripts/",
    verwacht: /FOUT scripts-typen .*1 typefout/,
    zet: (m) => schrijf(m, "scripts/kanarie-typen.ts", 'export const kanarie: number = "geen getal";\n'),
  },
  {
    stap: "python-tests",
    wat: "falende test in tools/brein",
    verwacht: /FOUT python-tests .*unittest faalde/,
    zet: (m) =>
      schrijf(m, "tools/brein/test_kanarie.py", "import unittest\n\nclass T(unittest.TestCase):\n    def test_kanarie(self):\n        self.assertEqual(1, 2)\n"),
  },
  {
    stap: "biome",
    wat: "een debugger-statement",
    verwacht: /FOUT biome/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-biome.ts", "export function kanarie() {\n  debugger;\n}\n"),
  },
  {
    stap: "taken",
    wat: "typefout in apps/template (typecheck)",
    verwacht: /FOUT taken .*@lab-bawuah\/template#typecheck/,
    zet: (m) => schrijf(m, "apps/template/src/kanarie-tsc.ts", 'export const kanarie: number = "geen getal";\n'),
  },
  {
    stap: "taken",
    wat: "hook in een if in apps/site (lint)",
    verwacht: /FOUT taken .*@lab-bawuah\/site#lint/,
    zet: (m) =>
      schrijf(
        m,
        "apps/site/components/kanarie-lint.tsx",
        '"use client";\nimport { useState } from "react";\nexport function Kanarie({ a }: { a: boolean }) {\n  if (a) useState(0);\n  return null;\n}\n',
      ),
  },
  {
    stap: "taken",
    wat: "falende unittest in apps/template (test)",
    verwacht: /FOUT taken .*@lab-bawuah\/template#test/,
    zet: (m) => {
      pasPkgAan(m, "apps/template/package.json", (p) => (p.scripts.test = "bun test ./kanarie"));
      schrijf(m, "apps/template/kanarie/kanarie.test.ts", 'import { expect, test } from "bun:test";\ntest("kanarie", () => expect(1).toBe(2));\n');
    },
  },
  {
    stap: "build",
    wat: "import van een bestand dat niet bestaat in apps/template",
    verwacht: /FOUT build .*@lab-bawuah\/template#build/,
    zet: (m) => schrijf(m, "apps/template/src/main.tsx", `${readFileSync(path.join(m, "apps/template/src/main.tsx"), "utf8")}import "./bestaat-niet";\n`),
  },
  {
    stap: "e2e",
    wat: "falende e2e in apps/template",
    verwacht: /FOUT e2e .*@lab-bawuah\/template/,
    zet: (m) => pasPkgAan(m, "apps/template/package.json", (p) => (p.scripts.e2e = "echo kanarie-e2e && exit 1")),
  },
];

/**
 * Kopie van de werkkopie (getrackte en niet-genegeerde bestanden, dus ook wat
 * nog niet gecommit is) in een eigen, losse git-repo met één commit. De poort
 * draait daar met --base HEAD: alleen de kanarie is dan affected. Een losse repo
 * en geen `git worktree add`, zodat de echte repo en zijn worktree-lijst
 * onaangeraakt blijven.
 */
function maakKopie(): string {
  const map = mkdtempSync(path.join(tmpdir(), "poort-zelftest-"));
  const lijst = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  for (const f of lijst) {
    const bron = path.join(ROOT, f);
    if (!existsSync(bron)) continue; // verwijderd in de werkkopie
    mkdirSync(path.dirname(path.join(map, f)), { recursive: true });
    cpSync(bron, path.join(map, f));
  }
  const id = ["-c", "user.name=poort", "-c", "user.email=poort@localhost", "-c", "commit.gpgsign=false"];
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], [...id, "commit", "-q", "-m", "basis"]]) {
    const r = draai(["git", ...args], {}, map);
    if (r.code !== 0) throw new Error(`zelftest: git ${args.join(" ")}: ${r.uit}`);
  }
  // Vangnet: de kopie moet een eigen repo zijn, nooit de echte (GIT_DIR uit een hook wordt al weggefilterd in draai()).
  const gitDir = draai(["git", "rev-parse", "--absolute-git-dir"], {}, map).uit.trim();
  if (realpathSync(gitDir) !== realpathSync(path.join(map, ".git"))) throw new Error(`zelftest: kopie gebruikt de verkeerde repo (${gitDir})`);
  const inst = draai(["bun", "install", "--frozen-lockfile"], {}, map);
  if (inst.code !== 0) throw new Error(`zelftest: bun install faalde\n${inst.uit}`);
  return map;
}

function herstel(map: string): void {
  draai(["git", "reset", "-q"], {}, map);
  draai(["git", "checkout", "--", "."], {}, map);
  draai(["git", "clean", "-fdq"], {}, map);
}

async function zelftest(): Promise<number> {
  const begin = Date.now();
  console.log("zelftest: kopie van de werkkopie maken en installeren…");
  const map = maakKopie();
  // Zonder de PR-context van de omgeving (CI): anders beoordeelt de kopie de echte PR.
  const geenPr = { GITHUB_EVENT_PATH: "", GITHUB_HEAD_REF: "", PR_TITEL: "", PR_BODY: "", PR_BRANCH: "main" };
  const poortIn = (alleen: string, env: Record<string, string> = {}) =>
    draai(["bun", "run", "scripts/poort.ts", "--base", "HEAD", "--alleen", alleen], { ...geenPr, ...env }, map);
  let fouten = 0;
  try {
    // Controle: zonder kanarie moet elke stap groen zijn, anders bewijst rood niets.
    const schoon = poortIn(STAPPEN.join(","));
    if (schoon.code !== 0) {
      console.log(`FOUT zelftest controle: de schone kopie is al rood\n${staart(schoon.uit)}`);
      return 1;
    }
    console.log("OK   zelftest controle: schone kopie groen");
    for (const k of KANARIES) {
      k.zet(map);
      // ds-regels scant alleen getrackte bestanden (git ls-files); een kanarie is
      // een nieuw bestand, dus eerst stagen.
      draai(["git", "add", "-A"], {}, map);
      const t0 = Date.now();
      const r = poortIn(k.stap, k.env);
      const rood = r.code !== 0 && k.verwacht.test(r.uit);
      if (!rood) fouten++;
      console.log(
        `${rood ? "OK  " : "FOUT"} zelftest ${k.stap.padEnd(10)} ${rood ? "keurt af" : "keurt NIET af"}: ${k.wat} (${duur(Date.now() - t0)})`,
      );
      if (rood) console.log(`     ${r.uit.match(k.verwacht)?.[0]}`);
      else console.log(staart(r.uit, 20));
      herstel(map);
    }
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
  console.log(`zelftest: ${fouten ? `${fouten} FOUT` : `alle ${KANARIES.length} kanaries afgekeurd`} in ${duur(Date.now() - begin)}`);
  return fouten;
}

// ── Main ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  let o: Opties;
  try {
    o = leesOpties(process.argv.slice(2));
  } catch (e) {
    console.error(`poort: ${(e as Error).message}`);
    process.exit(2);
  }
  if (o.baseline) {
    schrijfBaseline();
    process.exit(0);
  }
  process.exit(o.zelftest ? await zelftest() : await poort(o));
}
