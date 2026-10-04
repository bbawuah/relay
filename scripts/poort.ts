// De poort vóór elke merge:  bun run poort   (snelle helft: bun run check)
//
// Eén script dat lokaal, in de pre-push-hook en later in CI hetzelfde doet
// (PLAN-kwaliteit §4, fase 1). Stappen, in deze volgorde:
//
//   sherif      dependency-regels over alle package.json's      (hele repo)
//   boundaries  turbo boundaries: imports zonder dependency      (hele repo)
//   biome       biome ci: lint (alleen foutregels), geen format  (hele repo)
//   taken       turbo run lint typecheck test                    (affected)
//   build       turbo run build, zonder de site (zie baseline)   (affected)
//   e2e         turbo run e2e --concurrency=1                    (affected; tmux, watchparty, storybook-axe)
//
// sherif en boundaries vergelijken met scripts/poort-baseline.json: bekende
// schendingen zijn schuld, een nieuwe is FOUT, en een opgeloste die nog in de
// baseline staat ook (dan de regel weghalen, zodat de baseline alleen krimpt).
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
//   --alleen <s,…>   alleen deze stappen (sherif,boundaries,biome,taken,build,e2e)
//   --zelftest       bewijs dat elke stap afkeurt: per stap een bewuste fout in een
//                    tijdelijke kopie van de werkkopie; de poort moet daar rood worden
//   --baseline       schrijf de huidige sherif- en boundaries-schendingen naar de
//                    baseline (alleen bewust gebruiken; de diff hoort in review)
//
// Uitvoer: één regel per stap, OK / FOUT / SKIP, zoals rooktest.sh. Exitcode =
// aantal FOUT. Het stiltevenster (05:00–07:15) geldt voor de e2e-stap: daarin is
// e2e FOUT in plaats van stil overgeslagen; gebruik dan --zonder-e2e.
//
// Een groene volledige run op een schone werkkopie laat een stempel achter in
// ~/.cache/lab-bawuah/poort/<sha>.json, voor de uitrolscripts (besluit 10, later).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PAD = path.join(ROOT, "scripts/poort-baseline.json");
const STAPPEN = ["sherif", "boundaries", "biome", "taken", "build", "e2e"] as const;
type Stap = (typeof STAPPEN)[number];

// ── Opties ──────────────────────────────────────────────────────────────────

export type Opties = {
  alles: boolean;
  zonderE2e: boolean;
  base: string | null;
  alleen: Stap[] | null;
  zelftest: boolean;
  baseline: boolean;
};

export function leesOpties(args: string[]): Opties {
  const o: Opties = { alles: false, zonderE2e: false, base: null, alleen: null, zelftest: false, baseline: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue; // `bun run poort -- --alles`
    else if (a === "--alles") o.alles = true;
    else if (a === "--zonder-e2e") o.zonderE2e = true;
    else if (a === "--zelftest") o.zelftest = true;
    else if (a === "--baseline") o.baseline = true;
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
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TURBO_TELEMETRY_DISABLED: "1", ...env },
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
  uitzonderingen: { build: { zonder: string[]; reden: string; weg_als: string } };
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

function metBaseline(soort: "sherif" | "boundaries", r: Uitkomst, sleutels: string[]): Resultaat {
  const bekend = leesBaseline()[soort];
  if (r.code !== 0 && sleutels.length === 0) {
    return { status: "FOUT", detail: "onverwachte uitvoer", uitleg: staart(r.uit) };
  }
  const { nieuw, opgelost } = vergelijk(sleutels, bekend);
  if (!nieuw.length && !opgelost.length) {
    return { status: "OK", detail: sleutels.length ? `${sleutels.length} bekend in baseline` : undefined };
  }
  const regels = [
    ...nieuw.map((k) => `     nieuw: ${k}`),
    ...opgelost.map((k) => `     opgelost, haal weg uit scripts/poort-baseline.json: ${k}`),
  ];
  const kop = [nieuw.length && `${nieuw.length} nieuw`, opgelost.length && `${opgelost.length} opgelost`].filter(Boolean).join(", ");
  return { status: "FOUT", detail: kop, uitleg: regels.join("\n") + (nieuw.length ? `\n${staart(r.uit, 30)}` : "") };
}

function stapSherif(): Resultaat {
  const r = draai([bin("sherif")]);
  return metBaseline("sherif", r, sherifSleutels(r.uit));
}

function stapBoundaries(): Resultaat {
  const r = draai([bin("turbo"), "boundaries"]);
  return metBaseline("boundaries", r, boundarySleutels(r.uit));
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

function stapTaken(ctx: Context): Resultaat {
  return turboResultaat(turbo(ctx, ["lint", "typecheck", "test"]));
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
      : s === "biome" ? stapBiome()
      : s === "taken" ? stapTaken(ctx)
      : s === "build" ? stapBuild(ctx)
      : stapE2e(ctx);
    if (r.status === "FOUT") fouten++;
    const tijd = r.status === "SKIP" ? "" : ` (${duur(Date.now() - t0)})`;
    console.log(`${r.status.padEnd(4)} ${s.padEnd(14)}${r.detail ? ` ${r.detail}` : ""}${tijd}`);
    if (r.status === "FOUT" && r.uitleg) console.log(r.uitleg);
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
  writeFileSync(BASELINE_PAD, JSON.stringify(b, null, 2) + "\n");
  console.log(`baseline: ${b.sherif.length} sherif, ${b.boundaries.length} boundaries → scripts/poort-baseline.json`);
}

// ── Zelftest ────────────────────────────────────────────────────────────────

type Kanarie = { stap: Stap; wat: string; verwacht: RegExp; zet: (map: string) => void };

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
  const inst = draai(["bun", "install", "--frozen-lockfile"], {}, map);
  if (inst.code !== 0) throw new Error(`zelftest: bun install faalde\n${inst.uit}`);
  return map;
}

function herstel(map: string): void {
  draai(["git", "checkout", "--", "."], {}, map);
  draai(["git", "clean", "-fdq"], {}, map);
}

async function zelftest(): Promise<number> {
  const begin = Date.now();
  console.log("zelftest: kopie van de werkkopie maken en installeren…");
  const map = maakKopie();
  const poortIn = (alleen: string) =>
    draai(["bun", "run", "scripts/poort.ts", "--base", "HEAD", "--alleen", alleen], {}, map);
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
      const t0 = Date.now();
      const r = poortIn(k.stap);
      const rood = r.code !== 0 && k.verwacht.test(r.uit);
      if (!rood) fouten++;
      console.log(
        `${rood ? "OK  " : "FOUT"} zelftest ${k.stap.padEnd(10)} ${rood ? "keurt af" : "keurt NIET af"}: ${k.wat} (${duur(Date.now() - t0)})`,
      );
      if (!rood) console.log(staart(r.uit, 20));
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
