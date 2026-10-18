import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../test-integriteit.ts";
import { metStartHerstel, stopReden } from "./spawn-crash.ts";
import { STANDAARD_POORT, bouwBody, ciWorkflow, geenCiMelding, gevaarScore, onschadelijk, standaardPoort, inStiltevenster, kiesPrs, leesMarker, leesOpties, leesStempel, okRegels, stempelVan, zwaarsteGevaar, type Pr } from "./wachtrij.ts";

// Alle CLI-tests draaien met een nep-gh vooraan op PATH en een wegwerp-git-repo met een
// lokale bare "origin". Geen echte GitHub, geen echte PR's, geen echte poort (--poort-cmd).
// Geen echte klok: de tijd gaat mee met --nu.

const WACHTRIJ = join(import.meta.dir, "wachtrij.ts");
const MERGE = join(import.meta.dir, "merge.sh");

const pr = (n: number, o: Partial<Pr> = {}): Pr => {
  const oid = String(n).repeat(40).slice(0, 40);
  return {
    number: n,
    title: `PR ${n}`,
    body: "",
    headRefName: `tak-${n}`,
    headRefOid: oid,
    baseRefName: "main",
    isCrossRepository: false,
    comments: [{ body: `Lead-review: akkoord ${oid.slice(0, 7)}` }],
    ...o,
  };
};

describe("kiesPrs", () => {
  test("neemt alleen PR's met akkoord op de huidige head, op volgorde van nummer", () => {
    const { gekozen, afgevallen } = kiesPrs([
      pr(9),
      pr(3, { comments: [] }),
      pr(5, { comments: [{ body: "Lead-review: akkoord 1234567" }] }),
      pr(4, { isCrossRepository: true }),
      pr(2, { headRefName: "wachtrij/20261006-1200" }),
      pr(7),
    ]);
    expect(gekozen.map((p) => p.number)).toEqual([7, 9]);
    expect(afgevallen.map((a) => a.nummer).sort()).toEqual([2, 4, 5]);
    expect(afgevallen.find((a) => a.nummer === 5)?.reden).toMatch(/verouderd akkoord/);
  });

  test("een akkoord moet aan het begin van de comment staan en de hele sha7 hebben", () => {
    expect(kiesPrs([pr(1, { comments: [{ body: "ik: Lead-review: akkoord 1111111" }] })]).gekozen).toEqual([]);
    expect(kiesPrs([pr(1, { comments: [{ body: "Lead-review: akkoord 11111112" }] })]).gekozen).toEqual([]);
    expect(kiesPrs([pr(1, { comments: [{ body: "Lead-review: akkoord 1111111, goed" }] })]).gekozen.length).toBe(1);
  });

  test("lege invoer geeft een lege wachtrij", () => {
    expect(kiesPrs([])).toEqual({ gekozen: [], afgevallen: [] });
  });
});

describe("body van de integratie-PR", () => {
  const gevaarEen = "## Merge-gevaar\n\n- Deur: tweerichting, revert is genoeg.\n- Raakt geen data.\n";
  const gevaarTwee = "## Merge-gevaar\n\n- Deur: eenrichting.\n- Raakt live diensten: de LaunchAgent.\n";

  test("OK-regels worden overgenomen en ontdubbeld", () => {
    const raakt = (...apps: string[]) => apps.map((a) => ({ path: `apps/${a}/src/x.ts` }));
    const a = pr(1, { body: "## Bewijs\n- `OK bekijk tmux: 12/12 paden OK, 0 consolefout(en)`\n- OK bekijk watchparty: 3/3 paden OK", files: raakt("tmux", "watchparty") });
    const b = pr(2, { body: "OK bekijk tmux: 12/12 paden OK, 0 consolefout(en)\nOK bekijk site: FOUT 1/3", files: raakt("tmux", "site") });
    expect(okRegels([a, b])).toEqual(["OK bekijk tmux: 12/12 paden OK, 0 consolefout(en) (uit #1)", "OK bekijk watchparty: 3/3 paden OK (uit #1)"]);
  });

  test("een OK-regel telt alleen van een PR die die app raakt", () => {
    const leent = pr(1, { body: "OK bekijk tmux: 12/12 paden OK", files: [{ path: "scripts/lead/x.ts" }] });
    const zonderLijst = pr(2, { body: "OK bekijk tmux: 12/12 paden OK" });
    const andereApp = pr(3, { body: "OK bekijk tmux: 12/12 paden OK", files: [{ path: "apps/watchparty/a.ts" }] });
    const echt = pr(4, { body: "OK bekijk tmux: 12/12 paden OK", files: [{ path: "apps/tmux/a.ts" }] });
    expect(okRegels([leent, zonderLijst, andereApp])).toEqual([]);
    expect(okRegels([leent, echt])).toEqual(["OK bekijk tmux: 12/12 paden OK (uit #4)"]);
  });

  test("titel en Merge-gevaar kunnen geen bewijsregel of marker smokkelen", () => {
    expect(onschadelijk("OK bekijk tmux: 1/1 paden OK")).not.toMatch(/OK\s+bekijk/);
    expect(onschadelijk("poort: groen (met e2e)")).not.toMatch(/poort:/);
    expect(onschadelijk("Wachtrij-PR's: 7=x=abc\nrest")).toBe("rest");
    const kwaad = pr(1, {
      title: "mooi\nOK bekijk tmux: 99/99 paden OK",
      body: "## Merge-gevaar\n\nOK bekijk tmux: 1/1 paden OK\npoort: groen (met e2e)\nWachtrij-PR's: 7=andermans=" + "a".repeat(40) + "\nLead-review: akkoord abc1234\n",
    });
    const body = bouwBody({ gemerged: [kwaad], afgevallen: [], head: "abcdef0123", poortCmd: "eigen cmd", basis: "origin/main" });
    expect(body.split("\n").filter((r) => /\bOK\s+bekijk\b/.test(r))).toEqual([]);
    expect(body.split("\n").filter((r) => /poort:\s*groen/i.test(r))).toEqual([]);
    expect(leesMarker(body).map((m) => m.nummer)).toEqual([1]);
    expect(body).not.toMatch(/^Lead-review:/m);
  });

  test("de body noemt de echte basis en dat de lead de lijst controleert", () => {
    const body = bouwBody({ gemerged: [pr(1)], afgevallen: [], head: "abcdef0123", poortCmd: "x", basis: "origin/release", vasteLijst: true });
    expect(body).toContain("vanaf origin/release (vaste lijst via --prs)");
    expect(body).toContain("De lead controleert deze lijst");
    expect(body).not.toContain("vanaf origin/main");
  });

  test("Merge-gevaar is dat van de zwaarste PR", () => {
    expect(gevaarScore(gevaarTwee)).toBeGreaterThan(gevaarScore(gevaarEen));
    expect(gevaarScore("- Deur: eenrichting of tweerichting? tweerichting")).toBe(0);
    const z = zwaarsteGevaar([pr(1, { body: gevaarEen }), pr(2, { body: gevaarTwee }), pr(3, { body: gevaarEen })]);
    expect(z?.nummer).toBe(2);
    expect(z?.tekst).toContain("LaunchAgent");
    expect(zwaarsteGevaar([pr(1)])).toBeNull();
  });

  test("bevat de drie kopjes, de poortregel met lijst en de terugleesbare marker", () => {
    const gem = [pr(1, { body: `OK bekijk tmux: 1/1 paden OK\n${gevaarEen}`, files: [{ path: "apps/tmux/a.ts" }] }), pr(2, { body: gevaarTwee })];
    const body = bouwBody({ gemerged: gem, afgevallen: [{ nummer: 3, reden: "mergeconflict met de wachtrij" }], head: "abcdef0123", poortCmd: STANDAARD_POORT, basis: "origin/main" });
    expect(body).toMatch(/^## Samenvatting$/m);
    expect(body).toMatch(/^## Bewijs$/m);
    expect(body).toMatch(/^## Merge-gevaar$/m);
    expect(body).toContain("poort: groen (met e2e) op abcdef0");
    expect(body).toContain("#1, #2");
    expect(body).toContain("OK bekijk tmux: 1/1 paden OK (uit #1)");
    expect(body).toContain("#3: mergeconflict");
    expect(body).toContain("Generated with [Claude Code]");
    // dezelfde toets als bewijs-pr (scripts/bewijs-pr.ts) voor de poortregel
    const poortRegel = body.split("\n").find((r) => /poort:\s*groen/i.test(r))!;
    expect(/\bmet e2e\b/i.test(poortRegel)).toBe(true);
    expect(/(zonder|geen|skip)\s+e2e|e2e\s+(niet|overgeslagen)|niet gedraaid|overgeslagen/i.test(poortRegel)).toBe(false);
    expect(leesMarker(body)).toEqual(gem.map((p) => ({ nummer: p.number, tak: p.headRefName, sha: p.headRefOid })));
  });

  test("zonder marker geeft leesMarker niets", () => {
    expect(leesMarker("niets")).toEqual([]);
  });
});

// Echte vorm uit #89: Vercel zet eigen entries in de rollup, los van Actions.
const VERCEL = [
  { __typename: "StatusContext", context: "Vercel", state: "SUCCESS" },
  { __typename: "CheckRun", name: "Vercel Preview Comments", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "" },
];

describe("CI-workflownaam (één bron: lead.conf)", () => {
  test("standaard uit lead.conf; env LAB_MERGE_CI_WORKFLOW wint", () => {
    expect(ciWorkflow({})).toBe("CI");
    expect(ciWorkflow({ LAB_MERGE_CI_WORKFLOW: "Poort" })).toBe("Poort");
  });
  test("lead.conf zonder CI_WORKFLOW geeft een fout", () => {
    const conf = join(tmpdir(), `lead-conf-${process.pid}`);
    writeFileSync(conf, "ANDERS=1\n");
    try {
      expect(() => ciWorkflow({}, conf)).toThrow("CI_WORKFLOW ontbreekt");
    } finally {
      rmSync(conf, { force: true });
    }
  });
  test("geenCiMelding volgt de opgegeven workflow", () => {
    const rollup = [{ __typename: "CheckRun", workflowName: "Poort", name: "poort" }];
    expect(geenCiMelding(rollup, "abcdef1", "Poort")).toBeNull();
    expect(geenCiMelding(rollup, "abcdef1", "CI")).toContain("geen CI-run");
  });
  test("de sh-lezer en de regex-lezer halen dezelfde waarde uit lead.conf", () => {
    const conf = join(import.meta.dir, "lead.conf");
    const sh = Bun.spawnSync(["sh", "-c", `. "${conf}" && printf %s "$CI_WORKFLOW"`], { env: schoneEnv() }).stdout.toString();
    expect(sh).not.toBe("");
    expect(ciWorkflow({}, conf)).toBe(sh);
  });
  test("geen letterlijke workflownaam meer in merge.sh en wachtrij.ts", () => {
    expect(readFileSync(MERGE, "utf8")).not.toMatch(/workflowName == "CI"/);
    expect(readFileSync(WACHTRIJ, "utf8")).not.toMatch(/workflowName === "CI"/);
  });
});

describe("geenCiMelding", () => {
  test("leeg of ontbrekend = melding, met sha7", () => {
    expect(geenCiMelding([], "abcdef1234567")).toBe("geen CI-run voor abcdef1; sluit en heropen de PR of push opnieuw");
    expect(geenCiMelding(undefined, "abcdef1234567")).toContain("geen CI-run voor abcdef1");
  });
  test("alleen Vercel-entries (echte vorm uit #89) = melding", () => {
    expect(geenCiMelding(VERCEL, "abcdef1234567")).toContain("geen CI-run voor abcdef1");
  });
  test("een CI-CheckRun die nog bezig is = null", () => {
    expect(geenCiMelding([{ __typename: "CheckRun", workflowName: "CI", name: "melding", status: "IN_PROGRESS" }, ...VERCEL], "abcdef1")).toBeNull();
  });
  test("met een check-run = null", () => {
    expect(geenCiMelding([{ __typename: "CheckRun", workflowName: "CI", name: "poort" }], "abcdef1")).toBeNull();
  });
  test("--ci-wacht leest seconden", () => {
    expect((leesOpties(["--ci-wacht", "5"]) as { ciWacht: number }).ciWacht).toBe(5);
    expect(leesOpties(["--ci-wacht", "x"])).toMatch(/seconden/);
  });
});

describe("tijd en opties", () => {
  test("stiltevenster 05:00–07:15", () => {
    expect(inStiltevenster(leesStempel("20261006-0459")!)).toBe(false);
    expect(inStiltevenster(leesStempel("20261006-0500")!)).toBe(true);
    expect(inStiltevenster(leesStempel("20261006-0714")!)).toBe(true);
    expect(inStiltevenster(leesStempel("20261006-0715")!)).toBe(false);
  });

  test("stempel heen en terug", () => {
    expect(stempelVan(leesStempel("20261006-0905")!)).toBe("20261006-0905");
    expect(leesStempel("morgen")).toBeNull();
  });

  test("optiecontrole", () => {
    expect(leesOpties(["--nu", "morgen"])).toMatch(/jjjjmmdd-hhmm/);
    expect(leesOpties(["--zomaar"])).toMatch(/onbekende optie/);
    expect(leesOpties(["--poort-cmd"])).toMatch(/mist een waarde/);
    expect(leesOpties(["12"])).toMatch(/--ruim-takken/);
    expect(leesOpties(["--droog"])).toMatchObject({ droog: true, poortCmd: STANDAARD_POORT, prs: null });
    expect(STANDAARD_POORT).toContain("bun run poort --base origin/main");
    expect(leesOpties(["--basis", "origin/x"])).toMatchObject({ poortCmd: standaardPoort("origin/x") });
    expect(leesOpties(["--poort-cmd", "true", "--basis", "origin/x"])).toMatchObject({ poortCmd: "true" });
    expect(leesOpties(["--prs", "81,82,81"])).toMatchObject({ prs: [81, 82] });
    expect(leesOpties(["--prs", "81;82"])).toMatch(/--prs verwacht/);
    expect(leesOpties(["--prs", "81", "--ruim-takken"])).toMatch(/--prs hoort niet/);
  });
});

// echte-klok: elke CLI-test bouwt een wegwerprepo en draait tientallen git- en bun-subprocessen (~1s zonder belasting,
// tot >5s onder load). Alleen een bovengrens op de testduur; er wordt nergens op de klok gewacht.
setDefaultTimeout(60_000);

// ── CLI in een wegwerprepo ───────────────────────────────────────────────────

let dir: string;
let bin: string;
let repo: string;
let origin: string;
let wt: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...schoneEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  return { code: r.exitCode, uit: r.stdout.toString().trim(), fout: r.stderr.toString().trim() };
};
const schrijf = (naam: string, tekst: string) => {
  const p = join(bin, naam);
  writeFileSync(p, tekst);
  chmodSync(p, 0o755);
};
const sha = (tak: string) => git(repo, "rev-parse", tak).uit;
/** Een tak met één commit vanaf main die `bestand` schrijft. */
const maakTak = (naam: string, bestand: string, inhoud: string) => {
  git(repo, "checkout", "-q", "-b", naam, "main");
  writeFileSync(join(repo, bestand), inhoud);
  git(repo, "add", bestand);
  git(repo, "commit", "-q", "-m", `werk ${naam}`);
  git(repo, "push", "-q", "origin", naam);
  git(repo, "checkout", "-q", "main");
};
// LAB_WACHTRIJ_KLOK: vaste klok voor het stiltevenster, zodat de tests niet van het uur afhangen.
const omgeving = (extra: Record<string, string> = {}) => ({ ...schoneEnv(), PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, TMUX: "", TMUX_PANE: "", LAB_WACHTRIJ_KLOK: "20261006-1200", LAB_WACHTRIJ_CI_WACHT: "0", ...extra });
const draaiWachtrij = (args: string[], extra: Record<string, string> = {}) => {
  // Een bun-start-crash (SIGTRAP zonder uitvoer) wordt eenmaal herhaald; zie spawn-crash.ts.
  const { r } = metStartHerstel(() => Bun.spawnSync(["bun", WACHTRIJ, ...args], { cwd: repo, env: omgeving(extra) }));
  // code blijft null bij een signaal; `reden` zegt welk, zodat een rode test de oorzaak toont.
  return { code: r.exitCode, uit: r.stdout.toString(), fout: r.stderr.toString(), reden: stopReden(r) };
};
const log = (naam: string) => (existsSync(join(dir, naam)) ? readFileSync(join(dir, naam), "utf8") : "");
const zetPrs = (prs: Pr[]) => writeFileSync(join(dir, "prlist.json"), JSON.stringify(prs));
const remoteTakken = () => git(repo, "ls-remote", "--heads", "origin").uit;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wachtrij-test-"));
  bin = join(dir, "bin");
  repo = join(dir, "repo");
  origin = join(dir, "origin.git");
  wt = join(dir, "wt");
  mkdirSync(bin);
  mkdirSync(repo);
  schrijf(
    "gh",
    `#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_DIR/gh.log"
case "$1 $2" in
  "pr list") if [ "$3" = --base ]; then if [ -f "$FAKE_DIR/lijst-faalt" ]; then echo "nep: list mislukt" >&2; exit 1; fi; cat "$FAKE_DIR/base-$4.json" 2>/dev/null || echo "[]"; else cat "$FAKE_DIR/prlist.json"; fi; exit 0 ;;
  "pr edit") [ -f "$FAKE_DIR/edit-faalt" ] && { echo "nep: edit mislukt" >&2; exit 1; }; git --git-dir "$FAKE_DIR/origin.git" for-each-ref --format="$3 %(refname)" refs/heads >> "$FAKE_DIR/edit-zag.txt"; exit 0 ;;
  "pr view") if [ "$3" = "https://github.com/nep/nep/pull/99" ] && [ -f "$FAKE_DIR/ci.json" ]; then cat "$FAKE_DIR/ci.json"; exit 0; elif [ -f "$FAKE_DIR/prview-$3.json" ]; then cat "$FAKE_DIR/prview-$3.json"; else cat "$FAKE_DIR/prview.json"; fi; exit 0 ;;
  "pr merge") printf "%s\\n" "$@" > "$FAKE_DIR/merge.txt"; sed -i.bak 's/"state":"OPEN"/"state":"MERGED"/' "$FAKE_DIR/prview.json"; exit 0 ;;
  "api -X") [ "$3" = DELETE ] && { git --git-dir "$FAKE_DIR/origin.git" update-ref -d "refs/heads/\${4#repos/*/*/git/refs/heads/}"; exit $?; } ;;
  "pr create") [ -f "$FAKE_DIR/create-faalt" ] && { echo "nep: create mislukt" >&2; exit 1; }; printf "%s\n" "$@" > "$FAKE_DIR/create.txt"; echo "https://github.com/nep/nep/pull/99"; exit 0 ;;
esac
echo "nep-gh: onverwacht commando $*" >&2; exit 2
`,
  );
  git(dir, "init", "-q", "--bare", origin);
  git(repo, "init", "-q", "-b", "main");
  expect(git(repo, "rev-parse", "--git-dir").uit).toBe(".git"); // vangnet: dit is de wegwerprepo
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, "a.txt"), "begin\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "begin");
  git(repo, "push", "-q", "origin", "main");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("wachtrij.ts", () => {
  const prVoorTak = (n: number, tak: string, o: Partial<Pr> = {}) => {
    const oid = sha(tak);
    return pr(n, { headRefName: tak, headRefOid: oid, comments: [{ body: `Lead-review: akkoord ${oid.slice(0, 7)}` }], ...o });
  };

  test("lege wachtrij: meldt dat en doet niets", () => {
    zetPrs([]);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt]);
    expect(r.reden).toBe("exit 0");
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/leeg/);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "branch", "--list", "wachtrij/*").uit).toBe("");
  });

  test("--droog toont de lijst en raakt niets aan", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1"), pr(2, { comments: [] })]);
    const voor = git(repo, "worktree", "list").uit;
    const r = draaiWachtrij(["--droog", "--nu", "20261006-1200", "--map", wt]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain("#1 tak-1");
    expect(r.uit).toContain("wachtrij/20261006-1200");
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "worktree", "list").uit).toBe(voor);
    expect(log("gh.log")).not.toContain("pr create");
    expect(remoteTakken()).not.toContain("wachtrij/");
  });

  test("bouwt de wachtrij, haalt het conflict eruit, draait de poort en opent één PR", () => {
    maakTak("tak-1", "b.txt", "een\n");
    maakTak("tak-2", "c.txt", "twee\n");
    maakTak("tak-3", "a.txt", "conflict met 4\n");
    maakTak("tak-4", "a.txt", "andere inhoud\n");
    zetPrs([
      prVoorTak(1, "tak-1", { body: "OK bekijk tmux: 1/1 paden OK\n## Merge-gevaar\n- tweerichting\n" }),
      prVoorTak(2, "tak-2", { body: "## Merge-gevaar\n- eenrichting, raakt live diensten\n" }),
      prVoorTak(3, "tak-3"),
      prVoorTak(4, "tak-4"),
    ]);
    const poortLog = join(dir, "poort.log");
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", `pwd > ${poortLog} && ls >> ${poortLog}`]);
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/#4 eruit: mergeconflict/);
    // poort draaide in de wachtrij-worktree, mét de samengevoegde bestanden
    const p = readFileSync(poortLog, "utf8");
    expect(p).toContain("wt");
    expect(p).toMatch(/b\.txt/);
    expect(p).toMatch(/c\.txt/);
    // tak op de remote, merge-commits van de echte PR-heads
    expect(remoteTakken()).toContain("refs/heads/wachtrij/20261006-1200");
    const parents = git(wt, "log", "--merges", "--format=%P").uit.split("\n");
    expect(parents.length).toBe(3);
    expect(git(wt, "merge-base", "--is-ancestor", sha("tak-1"), "HEAD").code).toBe(0);
    expect(git(wt, "merge-base", "--is-ancestor", sha("tak-4"), "HEAD").code).not.toBe(0);
    // één PR, met sjabloon en de zwaarste Merge-gevaar-sectie
    const creates = log("gh.log").split("\n").filter((l) => l.startsWith("gh pr create"));
    expect(creates.length).toBe(1);
    expect(r.uit).toContain("https://github.com/nep/nep/pull/99");
    const hoofd = log("gh.log");
    expect(hoofd).toContain("--head wachtrij/20261006-1200");
    expect(hoofd).toContain("--base main");
  });

  test("integratie-PR zonder enige check-run: expliciete waarschuwing", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    writeFileSync(join(dir, "ci.json"), JSON.stringify({ statusCheckRollup: [], headRefOid: "1234567abcdef" }));
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain("geen CI-run voor 1234567; sluit en heropen de PR of push opnieuw");
  });

  test("integratie-PR met alleen Vercel-entries: waarschuwing", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    writeFileSync(join(dir, "ci.json"), JSON.stringify({ statusCheckRollup: VERCEL, headRefOid: "1234567abcdef" }));
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain("geen CI-run voor 1234567; sluit en heropen de PR of push opnieuw");
  });

  test("integratie-PR met een bezige CI-CheckRun (melding): geen CI-waarschuwing", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    writeFileSync(join(dir, "ci.json"), JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", workflowName: "CI", name: "melding", status: "IN_PROGRESS" }, ...VERCEL], headRefOid: "1234567abcdef" }));
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(r.uit).not.toContain("geen CI-run");
  });

  test("integratie-PR met een check-run: geen CI-waarschuwing", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    writeFileSync(join(dir, "ci.json"), JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", workflowName: "CI", name: "poort", status: "IN_PROGRESS" }], headRefOid: "1234567abcdef" }));
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(r.uit).not.toContain("geen CI-run");
  });

  test("een verschoven tak (andere sha dan het akkoord) valt eruit", () => {
    maakTak("tak-1", "b.txt", "een\n");
    maakTak("tak-2", "c.txt", "twee\n");
    zetPrs([prVoorTak(1, "tak-1"), prVoorTak(2, "tak-2", { headRefOid: "f".repeat(40), comments: [{ body: `Lead-review: akkoord fffffff` }] })]);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/#2 eruit: tak is verschoven/);
    expect(git(wt, "merge-base", "--is-ancestor", sha("tak-2"), "HEAD").code).not.toBe(0);
  });

  test("een verouderd akkoord telt niet mee (lege wachtrij)", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1", { comments: [{ body: "Lead-review: akkoord 0000000" }] })]);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt]);
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/#1 overgeslagen: verouderd akkoord/);
    expect(r.uit).toMatch(/leeg/);
  });

  test("twee takken op hetzelfde bestand: de tweede valt eruit, de eerste blijft", () => {
    maakTak("tak-1", "a.txt", "een\n");
    maakTak("tak-2", "a.txt", "twee\n");
    zetPrs([prVoorTak(1, "tak-1"), prVoorTak(2, "tak-2")]);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/#2 eruit/);
    expect(log("gh.log").split("\n").filter((l) => l.startsWith("gh pr create")).length).toBe(1);
  });

  test("rode poort: geen push en geen PR, worktree blijft staan", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "exit 3"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/poort rood \(exit 3\)/);
    expect(existsSync(wt)).toBe(true);
    expect(remoteTakken()).not.toContain("wachtrij/");
    expect(log("gh.log")).not.toContain("pr create");
  });

  test("weigert in het stiltevenster (maar --droog mag)", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    const stil = { LAB_WACHTRIJ_KLOK: "20261006-0600" };
    const r = draaiWachtrij(["--map", wt, "--poort-cmd", "true"], stil);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/stiltevenster/);
    expect(existsSync(wt)).toBe(false);
    const d = draaiWachtrij(["--droog", "--map", wt], stil);
    expect(d.code).toBe(0);
    expect(d.uit).toMatch(/stiltevenster/);
    // --nu kan het venster niet ontwijken: het bepaalt alleen de naam van de tak
    const omweg = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"], stil);
    expect(omweg.code).toBe(1);
    expect(omweg.fout).toMatch(/stiltevenster/);
  });

  test("een gestapelde PR (base niet main) valt af", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1", { baseRefName: "feature-x" })]);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/#1 overgeslagen: base is feature-x/);
    expect(existsSync(wt)).toBe(false);
  });

  test("--prs: alleen die PR's, in die volgorde; een PR zonder geldig akkoord valt af met reden", () => {
    maakTak("tak-1", "b.txt", "een\n");
    maakTak("tak-2", "c.txt", "twee\n");
    maakTak("tak-3", "d.txt", "drie\n");
    zetPrs([prVoorTak(1, "tak-1"), prVoorTak(2, "tak-2"), prVoorTak(3, "tak-3", { comments: [] })]);
    const droog = draaiWachtrij(["--droog", "--nu", "20261006-1200", "--map", wt, "--prs", "3,2"]);
    expect(droog.uit).toMatch(/#3 overgeslagen: niet open of zonder geldig akkoord/);
    expect(droog.uit).toMatch(/vaste lijst via --prs/);
    expect(droog.uit).not.toContain("#1 tak-1");
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true", "--prs", "2,3,9"]);
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/#9 overgeslagen/);
    expect(r.uit).toMatch(/Lead: controleer eerst de lijst PR's in de integratie-PR \(samengevoegd: #2; eruit: #3 #9\)/);
    expect(git(wt, "merge-base", "--is-ancestor", sha("tak-1"), "HEAD").code).not.toBe(0);
    expect(log("create.txt")).toContain("vaste lijst via --prs");
  });

  test("de body noemt de echte --basis en de poort draait met --base", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    git(repo, "push", "-q", "origin", "main:refs/heads/release");
    const droog = draaiWachtrij(["--droog", "--nu", "20261006-1200", "--map", wt, "--basis", "origin/release"]);
    expect(droog.uit).toContain("bun run poort --base origin/release");
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--basis", "origin/release", "--poort-cmd", "true"]);
    expect(r.code).toBe(0);
    expect(log("create.txt")).toContain("vanaf origin/release");
    expect(log("create.txt")).toContain("--base\nmain\n"); // de PR-basis blijft main
  });

  test("na een rode poort of mislukte PR staat wat er blijft staan in de melding", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    const rood = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "exit 3"]);
    expect(rood.fout).toContain(`worktree ${wt}`);
    expect(rood.fout).toContain("lokale tak wachtrij/20261006-1200");
    expect(rood.fout).toContain(`git worktree remove ${wt}; git branch -d wachtrij/20261006-1200`);
    expect(rood.fout).not.toContain("remote tak");
    git(repo, "worktree", "remove", "--force", wt);
    git(repo, "branch", "-D", "wachtrij/20261006-1200");

    writeFileSync(join(dir, "create-faalt"), "");
    const pr = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(pr.code).toBe(1);
    expect(pr.fout).toMatch(/PR openen mislukt: nep: create mislukt/);
    expect(pr.fout).toContain("remote tak origin/wachtrij/20261006-1200 (al gepusht)");
    expect(pr.fout).toContain("git push origin --delete wachtrij/20261006-1200");
    expect(remoteTakken()).toContain("refs/heads/wachtrij/20261006-1200");
  });

  test("een eigen poort-cmd krijgt geen 'met e2e' in de body", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    expect(draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]).code).toBe(0);
    const create = log("create.txt");
    expect(create).toContain("geen e2e-bewijs");
    expect(create).not.toMatch(/poort: groen \(met e2e\)/);
  });

  test("een poort die bestanden achterlaat: geen push, geen PR", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "echo extra > bun.lock"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/gewijzigde bestanden achter/);
    expect(remoteTakken()).not.toContain("wachtrij/");
    expect(log("gh.log")).not.toContain("pr create");
  });

  test("weigert een bestaande map", () => {
    maakTak("tak-1", "b.txt", "een\n");
    zetPrs([prVoorTak(1, "tak-1")]);
    mkdirSync(wt);
    const r = draaiWachtrij(["--nu", "20261006-1200", "--map", wt, "--poort-cmd", "true"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/bestaat al/);
  });
});

describe("wachtrij.ts --ruim-takken", () => {
  /** Zet tak-1 en tak-2 op main en een prview.json van een gemergede integratie-PR. */
  const mergeNaarMain = (merged: string[], staat = "MERGED") => {
    const prs = merged.map((t, i) => ({ number: i + 1, headRefName: t, headRefOid: sha(t) }));
    for (const t of merged) git(repo, "merge", "-q", "--no-ff", "-m", `merge ${t}`, t);
    git(repo, "push", "-q", "origin", "main");
    for (const p of prs) writeFileSync(join(dir, `prview-${p.number}.json`), JSON.stringify({ state: "MERGED", headRefName: p.headRefName, headRefOid: p.headRefOid }));
    const marker = `Wachtrij-PR's: ${prs.map((p) => `${p.number}=${p.headRefName}=${p.headRefOid}`).join(" ")}`;
    writeFileSync(join(dir, "prview.json"), JSON.stringify({ state: staat, headRefName: "wachtrij/20261006-1200", body: `## Samenvatting\n\n${marker}\n` }));
  };

  test("verwijdert alleen takken waarvan de head in origin/main staat", () => {
    maakTak("tak-1", "b.txt", "een\n");
    maakTak("tak-2", "c.txt", "twee\n");
    mergeNaarMain(["tak-1"]);
    // tak-2 staat in de marker, maar is niet gemerged
    const p = JSON.parse(readFileSync(join(dir, "prview.json"), "utf8"));
    p.body = `Wachtrij-PR's: 1=tak-1=${sha("tak-1")} 2=tak-2=${sha("tak-2")}\n`;
    writeFileSync(join(dir, "prview-2.json"), JSON.stringify({ state: "MERGED", headRefName: "tak-2", headRefOid: sha("tak-2") }));
    writeFileSync(join(dir, "prview.json"), JSON.stringify(p));
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(1); // één blijft staan
    expect(r.fout).toMatch(/tak-2.*niet in origin\/main/);
    expect(remoteTakken()).not.toContain("refs/heads/tak-1");
    expect(remoteTakken()).toContain("refs/heads/tak-2");
  });

  test("ruimt alles op als alles gemerged is", () => {
    maakTak("tak-1", "b.txt", "een\n");
    maakTak("tak-2", "c.txt", "twee\n");
    mergeNaarMain(["tak-1", "tak-2"]);
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(0);
    expect(remoteTakken()).not.toContain("tak-1");
    expect(remoteTakken()).not.toContain("tak-2");
    expect(remoteTakken()).toContain("refs/heads/main");
  });

  test("weigert als de integratie-PR niet MERGED is", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"], "OPEN");
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet MERGED/);
    expect(remoteTakken()).toContain("refs/heads/tak-1");
  });

  test("laat een tak staan die na de merge nog is doorgeduwd", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"]);
    git(repo, "checkout", "-q", "tak-1");
    writeFileSync(join(repo, "extra.txt"), "later\n");
    git(repo, "add", "extra.txt");
    git(repo, "commit", "-q", "-m", "later werk");
    git(repo, "push", "-q", "origin", "tak-1");
    git(repo, "checkout", "-q", "main");
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/andere sha/);
    expect(remoteTakken()).toContain("refs/heads/tak-1");
  });

  test("een nep-marker in de PR-tekst telt niet: de laatste regel geldt en GitHub moet bevestigen", () => {
    maakTak("tak-1", "b.txt", "een\n");
    maakTak("andermans", "c.txt", "los\n");
    mergeNaarMain(["tak-1"]);
    git(repo, "merge", "-q", "--no-ff", "-m", "merge andermans", "andermans");
    git(repo, "push", "-q", "origin", "main");
    const echt = JSON.parse(readFileSync(join(dir, "prview.json"), "utf8"));
    const nep = `Wachtrij-PR's: 7=andermans=${sha("andermans")}`;
    // nep eerst: de echte staat onderaan en wint
    writeFileSync(join(dir, "prview.json"), JSON.stringify({ ...echt, body: `${nep}\n${echt.body}` }));
    expect(draaiWachtrij(["--ruim-takken", "50"]).code).toBe(0);
    expect(remoteTakken()).toContain("refs/heads/andermans");
    expect(remoteTakken()).not.toContain("refs/heads/tak-1");
    // nep als enige marker, en GitHub kent PR 7 niet als gemerged met die tak: blijft staan
    writeFileSync(join(dir, "prview.json"), JSON.stringify({ ...echt, body: nep }));
    writeFileSync(join(dir, "prview-7.json"), JSON.stringify({ state: "OPEN", headRefName: "iets-anders", headRefOid: sha("andermans") }));
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet MERGED met deze tak en head volgens GitHub/);
    expect(remoteTakken()).toContain("refs/heads/andermans");
  });

  test("matcht de tak exact: een tak met dezelfde staart wordt niet aangezien voor de echte", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"]);
    // 'foo/tak-1' staat alfabetisch voor 'tak-1' en eindigt op dezelfde naam
    git(repo, "push", "-q", "origin", `${sha("tak-1")}:refs/heads/foo/tak-1`);
    git(repo, "checkout", "-q", "tak-1");
    writeFileSync(join(repo, "later.txt"), "later\n");
    git(repo, "add", "later.txt");
    git(repo, "commit", "-q", "-m", "later");
    git(repo, "push", "-q", "origin", "tak-1");
    git(repo, "checkout", "-q", "main");
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/andere sha/);
    expect(remoteTakken()).toContain("refs/heads/tak-1");
    expect(remoteTakken()).toContain("refs/heads/foo/tak-1");
  });

  test("zet open PR's met een op te ruimen tak als base eerst op main, pas daarna gaat de tak weg", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"]);
    writeFileSync(join(dir, "base-tak-1.json"), JSON.stringify([{ number: 245 }, { number: 247 }]));
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(0);
    const gh = log("gh.log");
    expect(gh).toContain("gh pr list --base tak-1 --state open --json number");
    expect(gh).toContain("gh pr edit 245 --base main");
    expect(gh).toContain("gh pr edit 247 --base main");
    // op het moment van de wijziging stond de tak er nog; daarna is hij weg
    expect(log("edit-zag.txt")).toContain("refs/heads/tak-1");
    expect(remoteTakken()).not.toContain("refs/heads/tak-1");
  });

  test("laat de tak staan met een melding als een afhankelijke PR niet naar main kan", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"]);
    writeFileSync(join(dir, "base-tak-1.json"), JSON.stringify([{ number: 245 }]));
    writeFileSync(join(dir, "edit-faalt"), "");
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/PR #245 heeft tak-1 als base en kon niet naar main.*tak blijft staan/);
    expect(remoteTakken()).toContain("refs/heads/tak-1");
  });

  test("laat de tak staan als de afhankelijke PR's niet op te halen zijn", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"]);
    writeFileSync(join(dir, "lijst-faalt"), "");
    const r = draaiWachtrij(["--ruim-takken", "50"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet op te halen.*tak blijft staan/);
    expect(remoteTakken()).toContain("refs/heads/tak-1");
  });

  test("zonder afhankelijke PR's wordt niets gewijzigd en gaat de tak weg", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"]);
    expect(draaiWachtrij(["--ruim-takken", "50"]).code).toBe(0);
    expect(log("gh.log")).not.toContain("gh pr edit");
    expect(remoteTakken()).not.toContain("refs/heads/tak-1");
  });

  test("--droog verwijdert niets", () => {
    maakTak("tak-1", "b.txt", "een\n");
    mergeNaarMain(["tak-1"]);
    const r = draaiWachtrij(["--ruim-takken", "50", "--droog"]);
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/droog: zou remote tak tak-1/);
    expect(remoteTakken()).toContain("refs/heads/tak-1");
  });

  test("zonder marker of zonder wachtrij-tak: weigert", () => {
    writeFileSync(join(dir, "prview.json"), JSON.stringify({ state: "MERGED", headRefName: "wachtrij/x", body: "niets" }));
    expect(draaiWachtrij(["--ruim-takken", "50"]).fout).toMatch(/bevat geen/);
    writeFileSync(join(dir, "prview.json"), JSON.stringify({ state: "MERGED", headRefName: "tak-1", body: "Wachtrij-PR's: 1=tak-1=abc" }));
    expect(draaiWachtrij(["--ruim-takken", "50"]).fout).toMatch(/geen integratie-PR/);
  });
});

// ── bezitscheck in merge.sh ──────────────────────────────────────────────────

describe("merge.sh bezitscheck", () => {
  let contract: string;
  const prJson = (files: string[]) =>
    writeFileSync(
      join(dir, "prview.json"),
      JSON.stringify({
        state: "OPEN",
        headRefName: "lead/test-tak",
        headRefOid: "abc1234def5678abc1234def5678abc1234def56",
        isCrossRepository: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        comments: [{ body: "Lead-review: akkoord abc1234" }],
        statusCheckRollup: [{ __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "SUCCESS", status: "COMPLETED" }],
        files: files.map((path) => ({ path })),
      }),
    );
  const merge = (args: string[]) => {
    // merge.sh merget alleen als lead (LAB_AGENT_ROL=lead)
    const r = Bun.spawnSync(["/bin/bash", "-p", MERGE, ...args], { cwd: repo, env: { ...omgeving(), LAB_AGENT_ROL: "lead" } });
    return { code: r.exitCode, uit: r.stdout.toString(), fout: r.stderr.toString() };
  };

  beforeEach(() => {
    contract = join(dir, "contract.md");
    writeFileSync(
      contract,
      [
        "# Contract",
        "## D1 · e2e",
        "Bezit: `scripts/e2e-slot.ts` (+test)",
        "## D2 · merge-wachtrij en bezitscheck — tak `lead/wachtrij`",
        "Bezit: `scripts/lead/wachtrij.ts` (+test, nieuw), `scripts/lead/merge.sh` (alleen de bezitscheck), README in scripts/lead, `scripts/lead/*.test.ts`, `docs/`, `stapE2e`.",
        "- iets",
        "## D3 · sublead",
        "Bezit: `scripts/lead/spawn.sh`",
        "",
      ].join("\n"),
    );
  });

  test("bestanden binnen het Bezit: melding, exit 0 (droog)", () => {
    prJson(["scripts/lead/wachtrij.ts", "scripts/lead/wachtrij.test.ts", "scripts/lead/merge.sh", "docs/uitleg/een.md"]);
    const r = merge(["50", "--droog", "--contract", contract, "--spoor", "D2"]);
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/bezitscheck: alle bestanden/);
    expect(r.fout).not.toMatch(/waarschuwing/);
  });

  test("bestanden buiten het Bezit: waarschuwing, geen weigering", () => {
    prJson(["scripts/lead/wachtrij.ts", "scripts/poort.ts", "apps/tmux/src/app.tsx"]);
    const r = merge(["50", "--droog", "--contract", contract, "--spoor", "D2"]);
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/2 bestand\(en\) buiten het Bezit van spoor D2/);
    expect(r.fout).toContain("scripts/poort.ts");
    expect(r.fout).toContain("apps/tmux/src/app.tsx");
    expect(r.fout).not.toContain("scripts/lead/wachtrij.ts\n");
    expect(r.uit).toMatch(/droog: PR 50 voldoet/);
  });

  test("een ander spoor heeft een ander Bezit", () => {
    prJson(["scripts/lead/wachtrij.ts"]);
    const r = merge(["50", "--droog", "--contract", contract, "--spoor", "D3"]);
    expect(r.code).toBe(0);
    expect(r.fout).toContain("scripts/lead/wachtrij.ts");
  });

  test("de echte merge gebruikt --match-head-commit met de volledige head die tegen het akkoord is getoetst", () => {
    git(repo, "push", "-q", "origin", "main:refs/heads/lead/test-tak");
    prJson(["scripts/lead/wachtrij.ts"]);
    const droog = merge(["50", "--droog"]);
    expect(droog.uit).toContain("--match-head-commit abc1234def5678abc1234def5678abc1234def56");
    const r = merge(["50"]);
    expect(r.code).toBe(0);
    expect(log("merge.txt")).toBe("pr\nmerge\n50\n--merge\n--match-head-commit\nabc1234def5678abc1234def5678abc1234def56\n--repo\nbbawuah/LAB-BAWUAH\n");
    expect(remoteTakken()).not.toContain("lead/test-tak");
  });

  test("een afgekapte bestandslijst van gh wordt gemeld", () => {
    prJson(["scripts/lead/wachtrij.ts"]);
    const stuk = JSON.parse(readFileSync(join(dir, "prview.json"), "utf8"));
    writeFileSync(join(dir, "prview.json"), JSON.stringify({ ...stuk, changedFiles: 250 }));
    const r = merge(["50", "--droog", "--contract", contract, "--spoor", "D2"]);
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/zag 1 van 250 bestanden/);
  });

  test("een Bezit-map telt alleen vanaf de wortel, niet ergens halverwege het pad", () => {
    prJson(["docs/a.md", "apps/x/docs/b.md"]);
    const r = merge(["50", "--droog", "--contract", contract, "--spoor", "D2"]);
    expect(r.fout).toContain("apps/x/docs/b.md");
    expect(r.fout).not.toContain("docs/a.md\n");
  });

  test("CI-workflownaam komt uit lead.conf; LAB_MERGE_CI_WORKFLOW past hem aan", () => {
    prJson(["scripts/lead/wachtrij.ts"]);
    expect(merge(["1", "--droog"]).code).toBe(0);
    const r = Bun.spawnSync(["/bin/bash", "-p", MERGE, "1", "--droog"], { cwd: repo, env: omgeving({ LAB_MERGE_CI_WORKFLOW: "Andere" }) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("geen CI-run voor");
  });

  test("merge.sh vindt lead.conf ook vanaf een ander cwd", () => {
    prJson(["scripts/lead/wachtrij.ts"]);
    const r = Bun.spawnSync(["/bin/bash", "-p", MERGE, "1", "--droog"], { cwd: dir, env: omgeving() });
    expect(r.stderr.toString()).not.toContain("lead.conf");
    expect(r.exitCode).toBe(0);
  });

  test("fail-closed: faalt jq bij de CI-telling, dan weigert merge.sh", () => {
    prJson(["scripts/lead/wachtrij.ts"]);
    const echt = Bun.which("jq");
    expect(echt).toBeTruthy();
    writeFileSync(join(bin, "jq"), `#!/bin/sh\ncase "$*" in *"--arg w "*) exit 5 ;; esac\nexec "${echt}" "$@"\n`);
    chmodSync(join(bin, "jq"), 0o755);
    const r = merge(["1", "--droog"]);
    expect(r.code).toBe(1);
    expect(r.fout).toContain("CI-runs niet uitlezen");
  });

  test("fail-closed: lege jq-uitvoer bij de CI-telling weigert ook", () => {
    prJson(["scripts/lead/wachtrij.ts"]);
    const echt = Bun.which("jq");
    writeFileSync(join(bin, "jq"), `#!/bin/sh\ncase "$*" in *"--arg w "*) exit 0 ;; esac\nexec "${echt}" "$@"\n`);
    chmodSync(join(bin, "jq"), 0o755);
    const r = merge(["1", "--droog"]);
    expect(r.code).toBe(1);
    expect(r.fout).toContain("CI-runs niet uitlezen");
  });

  test("zonder --contract verandert er niets", () => {
    prJson(["wat/dan/ook.ts"]);
    const r = merge(["50", "--droog"]);
    expect(r.code).toBe(0);
    expect(r.fout).toBe("");
    expect(r.uit).not.toMatch(/bezitscheck/);
  });

  test("onbekend spoor, ontbrekend bestand of één vlag alleen: weigert", () => {
    prJson([]);
    expect(merge(["50", "--droog", "--contract", contract, "--spoor", "D9"]).fout).toMatch(/geen "Bezit:"-regel voor spoor D9/);
    expect(merge(["50", "--droog", "--contract", join(dir, "weg.md"), "--spoor", "D2"]).fout).toMatch(/niet gevonden/);
    expect(merge(["50", "--droog", "--contract", contract]).fout).toMatch(/horen bij elkaar/);
    expect(merge(["50", "--droog", "--spoor", "D2"]).fout).toMatch(/horen bij elkaar/);
  });

  test("een waarschuwing laat een echte merge wel door (en de weigeringen blijven gelden)", () => {
    prJson(["buiten/bezit.ts"]);
    const r = merge(["50", "--droog", "--contract", contract, "--spoor", "D2"]);
    expect(r.code).toBe(0);
    const stuk = JSON.parse(readFileSync(join(dir, "prview.json"), "utf8"));
    stuk.comments = [];
    writeFileSync(join(dir, "prview.json"), JSON.stringify(stuk));
    const g = merge(["50", "--droog", "--contract", contract, "--spoor", "D2"]);
    expect(g.code).toBe(1);
    expect(g.fout).toMatch(/Lead-review: akkoord/);
  });
});
