// De poort vóór elke merge:  bun run poort   (snelle helft: bun run check)
//
// Eén script dat lokaal, in de pre-push-hook en later in CI hetzelfde doet
// (PLAN-kwaliteit §4, fase 1). Stappen, in deze volgorde:
//
//   sherif      dependency-regels over alle package.json's      (hele repo)
//   boundaries  turbo boundaries: imports zonder dependency      (hele repo)
//   ds-regels   designsysteem-regels R1–R7 (scripts/ds-regels.ts) (alle apps)
//   werk-commentaar  TODO/HACK/FIXME/XXX/workaround alleen als TODO(JJJJ-MM-DD): reden; verlopen = FOUT
//   echte-klok  unittests wachten niet op de echte klok: Bun.sleep/setTimeout ≥ 10 ms = FOUT (scripts/echte-klok.ts)
//   test-integriteit  geen verwijderd testbestand, minder test(/it( of nieuwe .skip/.only/.todo zonder "// test-weg: reden" (scripts/test-integriteit.ts)
//   rood-op-basis  een fix (tak of PR-titel met "fix") brengt een unittest mee die op de basis faalt en op de tak slaagt (scripts/rood-op-basis.ts)
//   scripts-tests  bun test ./scripts/ (de tests van poort en ds-regels; < 1 s, altijd)
//   biome       biome ci: lint (alleen foutregels), geen format  (hele repo)
//   taken       turbo run lint typecheck test                    (affected)
//   build       turbo run build, zonder de site (zie baseline)   (affected)
//   e2e         turbo run e2e --concurrency=1                    (affected; tmux, watchparty, storybook-axe)
//
// sherif, boundaries en ds-regels vergelijken met scripts/poort-baseline.json:
// bekende schendingen zijn schuld, een nieuwe is FOUT, en een opgeloste die nog in
// de baseline staat ook (dan de regel weghalen, zodat de baseline alleen krimpt).
// ds-regels heeft daarnaast een allowlist met reden (UITZONDERINGEN in
// ds-regels.ts); een uitzondering die niets meer dekt is ook FOUT.
//
// Affected betekent: geraakt door de diff tussen de merge-base met --base en de
// werkkopie (ook niet-gecommitte wijzigingen). Standaard is de base `main`; sta
// je zelf op main (na een merge), dan `origin/main`: dan controleert de poort
// precies wat je gaat pushen.
//
// Opties:
//   --alles          geen affected: alle workspaces
//   --zonder-e2e     de e2e-stap overslaan (= bun run check, de pre-push-hook)
//   --base <ref>     vergelijk met deze ref in plaats van main
//   --ci             voor .github/workflows/ci.yml: sla de taken over die in
//                    uitzonderingen.ci van de baseline staan (alleen op de mini)
//   --alleen <s,…>   alleen deze stappen (sherif,boundaries,ds-regels,werk-commentaar,echte-klok,test-integriteit,rood-op-basis,scripts-tests,biome,taken,build,e2e)
//   --zelftest       bewijs dat elke stap afkeurt: per stap een bewuste fout in een
//                    tijdelijke kopie van de werkkopie; de poort moet daar rood worden
//   --baseline       schrijf de huidige sherif-, boundaries- en ds-regels-schendingen naar de
//                    baseline (alleen bewust gebruiken; de diff hoort in review)
//
// Uitvoer: één regel per stap, OK / FOUT / SKIP, zoals rooktest.sh. Exitcode =
// aantal FOUT. Het stiltevenster (05:00–07:15) geldt voor de e2e-stap: daarin is
// e2e FOUT in plaats van stil overgeslagen; gebruik dan --zonder-e2e.
//
// Een groene volledige run op een schone werkkopie laat een stempel achter in
// ~/.cache/lab-bawuah/poort/<sha>.json, voor de uitrolscripts (besluit 10, later).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ongebruikt, sleutels as dsSleutels, zoek as dsZoek } from "./ds-regels";
import { beschrijf as ekBeschrijf, nieuweTreffers as ekNieuw, OPLOSSING as EK_OPLOSSING, sleutel as ekSleutel, zoek as ekZoek } from "./echte-klok";
import { leesPr } from "./bewijs-pr";
import { leesContext as roLees, stap as roStap } from "./rood-op-basis";
import { analyseer as tiAnalyseer } from "./test-integriteit";
import { JUISTE_VORM, sleutel as wcSleutel, zoek as wcZoek } from "./werk-commentaar";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PAD = path.join(ROOT, "scripts/poort-baseline.json");
const STAPPEN = ["sherif", "boundaries", "ds-regels", "werk-commentaar", "echte-klok", "test-integriteit", "rood-op-basis", "scripts-tests", "biome", "taken", "build", "e2e"] as const;
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

type Uitkomst = { code: number; uit: string };

function draai(cmd: string[], env: Record<string, string> = {}, cwd = ROOT): Uitkomst {
  const p = Bun.spawnSync(cmd, {
    cwd,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), NO_COLOR: "1", FORCE_COLOR: "0", TURBO_TELEMETRY_DISABLED: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const uit = (p.stdout.toString() + p.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, "");
  return { code: p.exitCode ?? 1, uit };
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

/** Stiltevenster 05:00–07:15 lokale tijd (zelfde venster als de uitrolscripts). */
export function inStiltevenster(nu: Date = new Date()): boolean {
  const m = nu.getHours() * 60 + nu.getMinutes();
  return m >= 5 * 60 && m < 7 * 60 + 15;
}

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

type Resultaat = { status: "OK" | "FOUT" | "SKIP"; detail?: string; uitleg?: string };

type BaselineSoort = "sherif" | "boundaries" | "ds-regels" | "werk-commentaar" | "echte-klok";

function metBaseline(soort: BaselineSoort, r: Uitkomst, sleutels: string[], extra: string[] = [], extraLabel = "allowlist verouderd"): Resultaat {
  const bekend = leesBaseline()[soort] ?? [];
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
  const r = metBaseline("ds-regels", { code: 0, uit: "" }, dsSleutels(uitslagen), verouderd);
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
  const r = metBaseline("werk-commentaar", { code: 0, uit: "" }, ongeldig, verlopen, "verlopen");
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
  const r = metBaseline("echte-klok", { code: 0, uit: "" }, treffers.map(ekSleutel));
  if (r.status !== "FOUT") return r;
  const nieuw = ekNieuw(treffers, leesBaseline()["echte-klok"] ?? []).map((t) => `     ${ekBeschrijf(t)}`);
  return { ...r, uitleg: `${r.uitleg}${nieuw.length ? `\n${nieuw.join("\n")}` : ""}
     Op een trage runner wordt dat flaky; oplossing: ${EK_OPLOSSING}` };
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
function stapRoodOpBasis(base: string): Resultaat {
  return roStap(base, roLees());
}

/** De root is geen workspace, dus turbo draait deze tests niet; deze stap wel (altijd, < 1 s). */
function stapScriptsTests(): Resultaat {
  const r = draai(["bun", "test", "./scripts/"]);
  const pass = r.uit.match(/^\s*(\d+) pass/m)?.[1];
  const fail = r.uit.match(/^\s*(\d+) fail/m)?.[1];
  if (r.code === 0) return { status: "OK", detail: pass ? `${pass} tests` : undefined };
  return { status: "FOUT", detail: fail ? `${fail} mislukt` : "bun test faalde", uitleg: staart(r.uit) };
}

function stapBiome(): Resultaat {
  const r = draai([bin("biome"), "ci", "--colors=off", "--max-diagnostics=20", "."]);
  return r.code === 0 ? { status: "OK" } : { status: "FOUT", uitleg: staart(r.uit) };
}

type Context = { affected: boolean; base: string | null; env: Record<string, string> };

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

function stapTaken(ctx: Context, ci: boolean): Resultaat {
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

function stapE2e(ctx: Context): Resultaat {
  const dry = turbo(ctx, ["e2e"], ["--dry=json"]);
  if (dry.code !== 0) return { status: "FOUT", detail: "turbo --dry faalde", uitleg: staart(dry.uit) };
  const plan = JSON.parse(dry.uit.slice(dry.uit.indexOf("{")));
  const e2e = (plan.tasks as { task: string; package: string; command: string }[])
    .filter((t) => t.task === "e2e" && t.command !== "<NONEXISTENT>")
    .map((t) => t.package);
  if (!e2e.length) return { status: "SKIP", detail: "geen e2e geraakt" };
  if (inStiltevenster()) {
    return { status: "FOUT", detail: `stiltevenster 05:00–07:15, e2e van ${e2e.join(", ")} niet gedraaid; na 07:15 opnieuw, of --zonder-e2e` };
  }
  const r = turboResultaat(turbo(ctx, ["e2e"], ["--concurrency=1"]));
  return { ...r, detail: `${e2e.join(", ")}: ${r.detail}` };
}

// ── Base ────────────────────────────────────────────────────────────────────

function kiesBase(gevraagd: string | null): { ref: string; sha: string } {
  let ref = gevraagd ?? "main";
  if (!gevraagd) {
    const head = git("rev-parse", "HEAD");
    const main = draai(["git", "rev-parse", "--verify", "-q", "main^{commit}"]).uit.trim();
    const origin = draai(["git", "rev-parse", "--verify", "-q", "origin/main^{commit}"]).uit.trim();
    if (main === head && origin) ref = "origin/main";
  }
  return { ref, sha: git("merge-base", ref, "HEAD") };
}

// ── Poort ───────────────────────────────────────────────────────────────────

async function poort(o: Opties): Promise<number> {
  const stappen = (o.alleen ?? [...STAPPEN]).filter((s) => !(o.zonderE2e && s === "e2e"));
  const ctx: Context = { affected: !o.alles, base: null, env: {} };
  if (!o.alles) {
    const base = kiesBase(o.base);
    ctx.base = base.sha;
    ctx.env = { TURBO_SCM_BASE: base.sha, TURBO_SCM_HEAD: "HEAD" };
    console.log(`poort: affected t.o.v. ${base.ref} (merge-base ${base.sha.slice(0, 9)})`);
  } else console.log("poort: alles");

  const stapBase = () => ctx.base ?? kiesBase(o.base).sha;
  const begin = Date.now();
  let fouten = 0;
  for (const s of STAPPEN) {
    if (!stappen.includes(s)) {
      if (s === "e2e" && o.zonderE2e) console.log("SKIP e2e            --zonder-e2e");
      continue;
    }
    const t0 = Date.now();
    const r =
      s === "sherif" ? stapSherif()
      : s === "boundaries" ? stapBoundaries()
      : s === "ds-regels" ? stapDsRegels()
      : s === "werk-commentaar" ? stapWerkCommentaar()
      : s === "echte-klok" ? stapEchteKlok()
      : s === "test-integriteit" ? stapTestIntegriteit(stapBase())
      : s === "rood-op-basis" ? stapRoodOpBasis(stapBase())
      : s === "scripts-tests" ? stapScriptsTests()
      : s === "biome" ? stapBiome()
      : s === "taken" ? stapTaken(ctx, o.ci)
      : s === "build" ? stapBuild(ctx)
      : stapE2e(ctx);
    if (r.status === "FOUT") fouten++;
    const tijd = r.status === "SKIP" ? "" : ` (${duur(Date.now() - t0)})`;
    console.log(`${r.status.padEnd(4)} ${s.padEnd(14)}${r.detail ? ` ${r.detail}` : ""}${tijd}`);
    if (r.uitleg && r.status !== "SKIP") console.log(r.uitleg);
  }
  console.log(`poort: ${fouten ? `${fouten} FOUT` : "groen"} in ${duur(Date.now() - begin)}`);

  // Stempel: alleen voor een volledige, groene run op een schone werkkopie.
  if (!fouten && !o.alleen && !o.zonderE2e && git("status", "--porcelain") === "") {
    const sha = git("rev-parse", "HEAD");
    const map = path.join(homedir(), ".cache/lab-bawuah/poort");
    mkdirSync(map, { recursive: true });
    writeFileSync(
      path.join(map, `${sha}.json`),
      JSON.stringify({ sha, modus: o.alles ? "alles" : "affected", base: ctx.base, tijd: new Date().toISOString() }) + "\n",
    );
  }
  return fouten;
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
  writeFileSync(BASELINE_PAD, JSON.stringify(b, null, 2) + "\n");
  console.log(
    `baseline: ${b.sherif.length} sherif, ${b.boundaries.length} boundaries, ${b["ds-regels"].length} ds-regels, ${b["werk-commentaar"].length} werk-commentaar, ${b["echte-klok"].length} echte-klok → scripts/poort-baseline.json`,
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
    verwacht: /FOUT scripts-tests .*1 mislukt/,
    zet: (m) => schrijf(m, "scripts/kanarie.test.ts", 'import { expect, test } from "bun:test";\ntest("kanarie", () => expect(1).toBe(2));\n'),
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
