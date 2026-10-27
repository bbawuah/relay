import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schoneEnv } from "../test-integriteit";
import { GIT_HARD_OPTIES, geweigerdeAanroep, gitArgs, gitHard, gitInWorktree, vertrouwdeWorktrees } from "./git-hard";
import { gitHardZonder } from "./git-hard.testhulp";
import { gitInfo } from "./hooks/status";

// Een wegwerprepo met de aanval uit de review van #679: in de worktree van een werker staat `sub/.git` (een bestand met
// `gitdir:` naar een eigen map met een config met core.fsmonitor), een gitlink in de index, en een relatief core.hooksPath
// met een hook van de werker. Elke hook of fsmonitor schrijft een markeerbestand; de geharde helper mag er geen laten ontstaan.

let dir: string;
let wt: string;
let evil: string;
let markFsmonitor: string;
let markHook: string;
let markFilter: string;
let hoofd: string;

const AUTEUR = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const env = (): Record<string, string> => ({ ...schoneEnv(), ...AUTEUR });
/** Een gewone git-aanroep, zoals de lead-tooling hem zonder helper zou doen. */
function rauw(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const schrijfUitvoerbaar = (pad: string, tekst: string) => {
  mkdirSync(path.dirname(pad), { recursive: true });
  writeFileSync(pad, tekst);
  chmodSync(pad, 0o755);
};
const gemerkt = (pad: string) => existsSync(pad);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "git-hard-"))); // echt pad: de pin weigert paden met een symlink (macOS: /var → /private/var)
  markFsmonitor = path.join(dir, "MARK-FSMONITOR");
  markHook = path.join(dir, "MARK-HOOK");
  markFilter = path.join(dir, "MARK-FILTER");
  hoofd = path.join(dir, "hoofd");
  wt = path.join(dir, "wt");
  evil = path.join(dir, "evil");

  mkdirSync(hoofd);
  rauw(hoofd, "init", "-q", "-b", "main");
  writeFileSync(path.join(hoofd, "a.txt"), "a\n");
  rauw(hoofd, "add", ".");
  rauw(hoofd, "commit", "-q", "-m", "init");
  rauw(hoofd, "config", "core.hooksPath", ".githooks"); // relatief, zoals in deze repo
  rauw(hoofd, "worktree", "add", "-q", "-b", "werker", wt);

  // De werker: een eigen repo `evil` met fsmonitor, gelinkt als `sub` met een gitlink in de index.
  mkdirSync(evil);
  rauw(evil, "init", "-q", "-b", "main");
  writeFileSync(path.join(evil, "x"), "x\n");
  rauw(evil, "add", ".");
  rauw(evil, "commit", "-q", "-m", "x");
  const fsm = path.join(dir, "fsmonitor.sh");
  schrijfUitvoerbaar(fsm, `#!/bin/sh\necho gedraaid >> "${markFsmonitor}"\nexit 0\n`);
  rauw(evil, "config", "core.fsmonitor", fsm);
  // Het filter-pad: een clean-filter in de config van sub, `* filter=k` in sub/.gitattributes en een gewijzigd bestand in sub.
  const filter = path.join(dir, "filter.sh");
  schrijfUitvoerbaar(filter, `#!/bin/sh\necho gedraaid >> "${markFilter}"\ncat\n`);
  rauw(evil, "config", "filter.k.clean", filter);
  rauw(evil, "config", "filter.k.process", filter);
  mkdirSync(path.join(wt, "sub"));
  writeFileSync(path.join(wt, "sub", ".git"), `gitdir: ${path.join(evil, ".git")}\n`);
  writeFileSync(path.join(wt, "sub", ".gitattributes"), "* filter=k\n");
  // Een .gitmodules van de werker met ignore=none gaat boven -c diff.ignoreSubmodules=all; alleen de vlag op de opdrachtregel wint.
  writeFileSync(path.join(wt, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./evil\n\tignore = none\n');
  writeFileSync(path.join(wt, "sub", "x"), "y\n"); // even lang als "x\n": git moet hashen (dus het filter draaien) om het verschil te zien
  rauw(wt, "update-index", "--add", "--cacheinfo", `160000,${rauw(evil, "rev-parse", "HEAD")},sub`);
  // De hook van de werker, relatief aan zijn worktree.
  schrijfUitvoerbaar(path.join(wt, ".githooks", "pre-commit"), `#!/bin/sh\necho gedraaid >> "${markHook}"\nexit 0\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("de aanval uit de review (voorwaarde)", () => {
  test("een gewone git status in de worktree voert de fsmonitor van sub/.git uit", () => {
    rauw(wt, "status", "--porcelain");
    expect(gemerkt(markFsmonitor)).toBe(true);
  });

  test("een gewone git commit in de worktree voert de relatieve hook van de werker uit", () => {
    rauw(wt, "commit", "-q", "--allow-empty", "-m", "x");
    expect(gemerkt(markHook)).toBe(true);
  });

  // De filter-route: diff, commit -a en diff-index kijken in sub en voeren daar het clean-filter uit.
  for (const [naam, args] of [
    ["diff --stat", ["diff", "--stat"]],
    ["diff --quiet", ["diff", "--quiet"]],
    ["diff HEAD", ["diff", "HEAD"]],
    ["commit -a", ["commit", "-a", "-q", "--allow-empty", "-m", "x"]],
    ["diff-index HEAD", ["diff-index", "HEAD"]],
  ] as const) {
    test(`een gewone git ${naam} voert het clean-filter van sub uit`, () => {
      try {
        rauw(wt, ...args);
      } catch {
        // diff --quiet en diff-index mogen met exit 1 eindigen; het gaat om het markeerbestand
      }
      expect(gemerkt(markFilter)).toBe(true);
    });
  }
});

describe("gitHard", () => {
  test("status, rev-parse, merge-base, diff en log in de worktree laten geen markeerbestand achter", () => {
    const kop = rauw(wt, "rev-parse", "HEAD");
    rmSync(markFsmonitor, { force: true });
    const uitslagen = [
      gitHard(wt, ["status", "--porcelain"]),
      gitHard(wt, ["rev-parse", "--abbrev-ref", "HEAD"]),
      gitHard(wt, ["merge-base", "--is-ancestor", "HEAD", "main"]),
      gitHard(wt, ["diff", "--stat"]),
      gitHard(wt, ["log", "-1", "--format=%H"]),
    ];
    expect(uitslagen.map((u) => u.code)).toEqual([0, 0, 0, 0, 0]);
    expect(uitslagen[4]?.uit).toBe(kop);
    expect(gemerkt(markFsmonitor)).toBe(false);
    expect(gemerkt(markHook)).toBe(false);
    expect(gemerkt(markFilter)).toBe(false);
  });

  test("diff --stat, diff --quiet, commit -a en diff-index HEAD voeren het filter en de fsmonitor van sub niet uit", () => {
    gitHard(wt, ["diff", "--stat"]);
    gitHard(wt, ["diff", "--quiet"]);
    gitHard(wt, ["diff-index", "HEAD"]);
    const c = gitHard(wt, ["commit", "-a", "-q", "--allow-empty", "-m", "x"], { env: env() });
    expect(c.code).toBe(0);
    expect(gemerkt(markFilter)).toBe(false);
    expect(gemerkt(markFsmonitor)).toBe(false);
    expect(gemerkt(markHook)).toBe(false);
  });

  test("met een .gitmodules ignore=none: diff, diff HEAD en log -p laten geen filter-markeerbestand achter", () => {
    gitHard(wt, ["diff", "--stat"]);
    gitHard(wt, ["diff", "--quiet"]);
    gitHard(wt, ["diff", "HEAD"]);
    gitHard(wt, ["log", "-p", "-1"]);
    expect(gemerkt(markFilter)).toBe(false);
    expect(gemerkt(markFsmonitor)).toBe(false);
  });

  test("stash en describe --dirty worden geweigerd (126) en draaien niets; describe zonder --dirty mag", () => {
    expect(gitHard(wt, ["stash"])).toMatchObject({ code: 126 });
    expect(gitHard(wt, ["stash", "list"])).toMatchObject({ code: 126 });
    expect(gitHard(wt, ["describe", "--dirty", "--always"])).toMatchObject({ code: 126 });
    expect(gitHard(wt, ["describe", "--dirty=-x"])).toMatchObject({ code: 126 });
    expect(gitInWorktree(hoofd, wt, ["stash"])).toMatchObject({ code: 126 });
    expect(geweigerdeAanroep(["describe", "--always"])).toBeNull();
    expect(gitHard(wt, ["describe", "--always"]).code).toBe(0);
    expect(gemerkt(markFilter)).toBe(false);
  });

  test("status en plumbing krijgen --ignore-submodules=all; andere subcommando's niet", () => {
    expect(gitArgs(["diff", "--stat"]).slice(-3)).toEqual(["diff", "--ignore-submodules=all", "--stat"]);
    expect(gitArgs(["status", "--porcelain"]).slice(-3)).toEqual(["status", "--ignore-submodules=all", "--porcelain"]);
    expect(gitArgs(["diff-index", "HEAD"]).slice(-3)).toEqual(["diff-index", "--ignore-submodules=all", "HEAD"]);
    expect(gitArgs(["diff-files"])).toContain("--ignore-submodules=all");
    expect(gitArgs(["log", "-1"])).not.toContain("--ignore-submodules=all");
    expect(gitHard(wt, ["status", "--porcelain"]).uit).not.toContain("sub");
  });

  test("een commit via de helper draait de hook van de werker niet; met hooks: true wel", () => {
    const c = gitHard(wt, ["commit", "-q", "--allow-empty", "-m", "x"], { env: env() });
    expect(c.code).toBe(0);
    expect(gemerkt(markHook)).toBe(false);
    rmSync(markFsmonitor, { force: true });
    gitHard(wt, ["commit", "-q", "--allow-empty", "-m", "y"], { env: env(), hooks: true });
    expect(gemerkt(markHook)).toBe(true);
    expect(gemerkt(markFsmonitor)).toBe(false); // ook met hooks aan blijft de fsmonitor uit
  });

  // test-weg: "worktree remove van een werker-worktree via de helper" bewees niets; git weigert dat altijd zelf
  // ("working trees containing submodules cannot be moved or removed"), dus er draaide nooit iets, met of zonder helper.

  test("GIT_*-variabelen van de aanroeper komen niet in het kind", () => {
    const oud = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(dir, "bestaat-niet");
    try {
      expect(gitHard(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).uit).toBe("werker");
    } finally {
      if (oud === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = oud;
    }
  });
});

describe("gitdir vastpinnen: een herschreven wt/.git telt niet", () => {
  // De werker herschrijft wt/.git naar een eigen gitdir (een kloon van hoofd) met een clean-filter, een diff.external en
  // een gpg.program in de config, en zet `* filter=k` in wt/.gitattributes. Geen -c-optie van de helper dekt die sleutels.
  let ev2: string;
  let markExtern: string;
  beforeEach(() => {
    ev2 = path.join(dir, "ev2");
    markExtern = path.join(dir, "MARK-EXTERN");
    rauw(dir, "clone", "-q", hoofd, ev2);
    const filter = path.join(dir, "filter2.sh");
    schrijfUitvoerbaar(filter, `#!/bin/sh\necho gedraaid >> "${markFilter}"\ncat\n`);
    const extern = path.join(dir, "extern.sh");
    schrijfUitvoerbaar(extern, `#!/bin/sh\necho gedraaid >> "${markExtern}"\nexit 0\n`);
    rauw(ev2, "config", "filter.k.clean", filter);
    rauw(ev2, "config", "diff.external", extern);
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(ev2, ".git")}\n`);
    writeFileSync(path.join(wt, ".gitattributes"), "* filter=k\n");
    writeFileSync(path.join(wt, "a.txt"), "b\n"); // even lang als "a\n": git moet hashen
  });

  test("voorwaarde: de helper zonder pin voert het filter en diff.external van de herschreven gitdir wel uit", () => {
    gitHard(wt, ["status", "--porcelain"]);
    gitHard(wt, ["diff"]);
    expect(gemerkt(markFilter)).toBe(true);
    expect(gemerkt(markExtern)).toBe(true);
  });

  test("gitInWorktree: geen filter, geen diff.external, en hij leest nog steeds de echte gitdir van de worktree", () => {
    const tak = gitInWorktree(hoofd, wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(tak).toMatchObject({ code: 0, uit: "werker" });
    gitInWorktree(hoofd, wt, ["status", "--porcelain"]);
    gitInWorktree(hoofd, wt, ["diff"]);
    gitInWorktree(hoofd, wt, ["diff", "--stat"]);
    gitInWorktree(hoofd, wt, ["diff-index", "HEAD"]);
    gitInWorktree(hoofd, wt, ["commit", "-a", "-q", "--allow-empty", "-m", "x"], { env: env() });
    expect(gemerkt(markFilter)).toBe(false);
    expect(gemerkt(markExtern)).toBe(false);
    expect(gemerkt(markHook)).toBe(false);
    expect(gemerkt(markFsmonitor)).toBe(false);
  });

  test("gitInfo (lead status) gebruikt de pin: geen markeerbestand, en de echte tak", () => {
    const g = gitInfo(wt, hoofd);
    expect(g).toMatchObject({ bestaat: true, tak: "werker" });
    expect(gemerkt(markFilter)).toBe(false);
    expect(gemerkt(markExtern)).toBe(false);
    expect(gemerkt(markFsmonitor)).toBe(false);
  });

  test("gitInfo weigert een cwd die niet in git worktree list van de lead staat", () => {
    const vreemd = path.join(dir, "vreemd");
    mkdirSync(vreemd);
    rauw(vreemd, "init", "-q", "-b", "main");
    expect(gitInfo(vreemd, hoofd)).toEqual({ bestaat: true, schoon: null, tak: null, in_main: null });
  });

  test("gitInWorktree weigert een pad buiten de lijst en een gitdir van een andere repo (code 126)", () => {
    const vreemd = path.join(dir, "vreemd");
    mkdirSync(vreemd);
    rauw(vreemd, "init", "-q", "-b", "main");
    expect(gitInWorktree(hoofd, vreemd, ["status"])).toMatchObject({ code: 126 });
    expect(gitInWorktree(hoofd, path.join(dir, "bestaat-niet"), ["status"])).toMatchObject({ code: 126 });
    // andere repo als root: wt hoort daar niet bij
    expect(gitInWorktree(vreemd, wt, ["status"])).toMatchObject({ code: 126 });
    expect(gemerkt(markFilter)).toBe(false);
  });

  test("een herschreven <common>/worktrees/<n>/gitdir naar het pad van een andere worktree kaapt de pin niet (dubbel pad)", () => {
    const wt2 = path.join(dir, "wt2");
    rauw(hoofd, "worktree", "add", "-q", "-b", "tweede", wt2);
    const wtGitdir = vertrouwdeWorktrees(hoofd).find((v) => v.wt === wt)!.gitdir;
    writeFileSync(path.join(wtGitdir, "gitdir"), `${path.join(wt2, ".git")}\n`); // wt2 wijst nu naar twee gitdirs
    expect(vertrouwdeWorktrees(hoofd).map((v) => path.basename(v.wt))).toEqual(["hoofd"]);
    expect(gitInWorktree(hoofd, wt2, ["status", "--porcelain"])).toMatchObject({ code: 126 });
    expect(gitInWorktree(hoofd, wt, ["status", "--porcelain"])).toMatchObject({ code: 126 });
  });

  test("een wt-map die door een symlink naar een andere worktree is vervangen wordt geweigerd", () => {
    const wt2 = path.join(dir, "wt2");
    rauw(hoofd, "worktree", "add", "-q", "-b", "tweede", wt2);
    renameSync(wt, path.join(dir, "wt-weg"));
    symlinkSync(wt2, wt);
    // wt (symlink) en wt2 hebben nu hetzelfde echte pad: allebei vallen af (faalt dicht), alleen hoofd blijft
    expect(vertrouwdeWorktrees(hoofd).map((v) => path.basename(v.wt))).toEqual(["hoofd"]);
    expect(gitInWorktree(hoofd, wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toMatchObject({ code: 126 });
    expect(gitInWorktree(hoofd, wt2, ["rev-parse", "--abbrev-ref", "HEAD"])).toMatchObject({ code: 126 });
  });

  test("een gitdir-bestand dat niet exact naar <wt>/.git wijst telt niet mee", () => {
    const wtGitdir = vertrouwdeWorktrees(hoofd).find((v) => v.wt === wt)!.gitdir;
    writeFileSync(path.join(wtGitdir, "gitdir"), `${path.join(wt, "sub", ".git")}\n`);
    expect(vertrouwdeWorktrees(hoofd).find((v) => v.wt === wt)).toBeUndefined();
  });

  test("extensions.worktreeConfig aan én een config.worktree van de worktree: geweigerd (126); zonder dat bestand niet", () => {
    rauw(hoofd, "config", "extensions.worktreeConfig", "true");
    const wtGitdir = vertrouwdeWorktrees(hoofd).find((v) => v.wt === wt)!.gitdir;
    expect(gitInWorktree(hoofd, wt, ["rev-parse", "--abbrev-ref", "HEAD"]).code).toBe(0);
    writeFileSync(path.join(wtGitdir, "config.worktree"), `[filter "k"]\n\tclean = ${path.join(dir, "filter2.sh")}\n`);
    expect(gitInWorktree(hoofd, wt, ["status", "--porcelain"])).toMatchObject({ code: 126 });
    expect(gemerkt(markFilter)).toBe(false);
  });

  test("vertrouwdeWorktrees: hoofd en wt, met de gitdir uit <common>/worktrees/<naam>", () => {
    const lijst = vertrouwdeWorktrees(hoofd);
    expect(lijst.map((v) => path.basename(v.wt)).sort()).toEqual(["hoofd", "wt"]);
    const w = lijst.find((v) => path.basename(v.wt) === "wt")!;
    expect(path.basename(path.dirname(w.gitdir))).toBe("worktrees");
  });
});

describe("mutatietest: de test is rood als de helper een optie of de pin mist", () => {
  test("zonder -c core.fsmonitor= verschijnt het markeerbestand wel (diff, met de ignore-submodules-lagen ook weg)", () => {
    gitHardZonder(wt, ["diff", "--stat"], ["core.fsmonitor=", "diff.ignoreSubmodules=all", "--ignore-submodules=all"]);
    expect(gemerkt(markFsmonitor)).toBe(true);
  });

  test("zonder --ignore-submodules=all én zonder -c core.fsmonitor= verschijnt het markeerbestand bij status", () => {
    gitHardZonder(wt, ["status", "--porcelain"], ["core.fsmonitor=", "--ignore-submodules=all", "diff.ignoreSubmodules=all"]);
    expect(gemerkt(markFsmonitor)).toBe(true);
  });

  test("--ignore-submodules=all alleen houdt status al schoon (verdediging in de diepte)", () => {
    gitHardZonder(wt, ["status", "--porcelain"], ["core.fsmonitor="]);
    expect(gemerkt(markFsmonitor)).toBe(false);
  });

  test("zonder -c core.hooksPath=/dev/null draait de hook van de werker wel", () => {
    gitHardZonder(wt, ["commit", "-q", "--allow-empty", "-m", "x"], ["core.hooksPath=/dev/null"], { env: env() });
    expect(gemerkt(markHook)).toBe(true);
  });

  test("zonder -c diff.ignoreSubmodules=all draait het filter bij commit -a wel; bij diff houdt de vlag het schoon (diepte)", () => {
    gitHardZonder(wt, ["diff", "--stat"], ["diff.ignoreSubmodules=all"]);
    expect(gemerkt(markFilter)).toBe(false);
    gitHardZonder(wt, ["commit", "-a", "-q", "--allow-empty", "-m", "x"], ["diff.ignoreSubmodules=all"], { env: env() });
    expect(gemerkt(markFilter)).toBe(true);
  });

  test("diff zonder --ignore-submodules=all én zonder de config-sleutel draait het filter wel (.gitmodules ignore=none wint van de sleutel)", () => {
    gitHardZonder(wt, ["diff", "--stat"], ["diff.ignoreSubmodules=all", "--ignore-submodules=all"]);
    expect(gemerkt(markFilter)).toBe(true);
    rmSync(markFilter, { force: true });
    gitHardZonder(wt, ["diff", "--stat"], ["--ignore-submodules=all"]); // alleen de sleutel: de .gitmodules wint, dus de vlag is nodig
    expect(gemerkt(markFilter)).toBe(true);
  });

  test("diff-index zonder --ignore-submodules=all draait het filter wel (de config-sleutel geldt niet voor plumbing)", () => {
    gitHardZonder(wt, ["diff-index", "HEAD"], ["--ignore-submodules=all"]);
    expect(gemerkt(markFilter)).toBe(true);
  });

  test("zonder de gitdir-pin (wt/.git herschreven naar een eigen gitdir) draait het filter van de werker wel", () => {
    const ev2 = path.join(dir, "ev2");
    rauw(dir, "clone", "-q", hoofd, ev2);
    const filter = path.join(dir, "filter2.sh");
    schrijfUitvoerbaar(filter, `#!/bin/sh\necho gedraaid >> "${markFilter}"\ncat\n`);
    rauw(ev2, "config", "filter.k.clean", filter);
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(ev2, ".git")}\n`);
    writeFileSync(path.join(wt, ".gitattributes"), "* filter=k\n");
    writeFileSync(path.join(wt, "a.txt"), "b\n"); // even lang als "a\n": git moet hashen
    gitHardZonder(wt, ["status", "--porcelain"], []); // alle -c-opties aan, maar geen pin
    expect(gemerkt(markFilter)).toBe(true);
  });

  test("de opties staan allemaal in GIT_HARD_OPTIES", () => {
    expect(GIT_HARD_OPTIES).toEqual(["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-c", "diff.ignoreSubmodules=all", "-c", "core.commitGraph=false"]);
  });
});

describe("bronscan: git in de lead-tooling loopt via de helper", () => {
  const LEAD = import.meta.dir;
  const bronnen = (map: string, ext: RegExp): string[] =>
    readdirSync(map, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(map, e.name);
      if (e.isDirectory()) return e.name === "fixtures" || e.name === "codex-fixtures" || e.name === "node_modules" ? [] : bronnen(p, ext);
      return ext.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
    });
  const regels = (pad: string) => readFileSync(pad, "utf8").split("\n").map((tekst, i) => ({ tekst, nr: i + 1 }));
  const rel = (pad: string) => path.relative(LEAD, pad);
  const OPTIES = ["core.fsmonitor=", "core.hooksPath=/dev/null", "core.untrackedCache=false", "diff.ignoreSubmodules=all"];

  /** Bewuste uitzonderingen, met reden: `bestand` (relatief aan scripts/lead) plus een deel van de regel (leeg = het hele bestand). */
  const UITZONDERING: { bestand: string; bevat: string; reden: string }[] = [
    { bestand: "push.sh", bevat: "", reden: "draait in de worktree van wie pusht en zet daar bewust de hooks (pre-push-poort) aan; lead en Brian draaien push.sh nooit in een worktree van een werker (AGENTS.md)" },
    { bestand: "merge.sh", bevat: "git patch-id", reden: "leest een diff van stdin, geen repo of werkmap" },
    { bestand: "git-hard.testhulp.ts", bevat: "", reden: "testhulp van deze test, bouwt zelf de argv met GIT_HARD_OPTIES" },
    { bestand: "vaste-cyclus.js", bevat: "git log origin/main..HEAD", reden: "tekst in een prompt voor een sessie, geen aanroep" },
    { bestand: "vaste-cyclus.js", bevat: "git show origin/", reden: "tekst in een prompt voor een sessie, geen aanroep" },
    { bestand: "hooks/status.ts", bevat: 'kop.push("git")', reden: "kolomkop van de tabel, geen aanroep" },
    { bestand: "installeer-grens.ts", bevat: "throw new Error(`git ${args", reden: "foutmelding met de argumenten van een aanroep die al via gitArgs liep" },
    { bestand: "spawn.sh", bevat: "lees verder alleen git log", reden: "tekst in de opdrachtzin voor de sessie, geen aanroep" },
  ];
  /** Bestanden waar "git" als gegeven voorkomt (commandolijsten, meldingen): daar tellen alleen Python-aanroepen en een regel die met `git ` begint. */
  const ALLEEN_AANROEPEN = ["hooks/grenzen.sh"];
  const treffers = new Map<(typeof UITZONDERING)[number], number>();
  const uitgezonderd = (pad: string, tekst: string) => {
    const u = UITZONDERING.find((x) => x.bestand === rel(pad) && tekst.includes(x.bevat));
    if (u) treffers.set(u, (treffers.get(u) ?? 0) + 1);
    return !!u;
  };

  const TS_GIT = /["'`]git(["'`\s]|$)|\$`\s*git\b/;
  test("de TS-scan vangt de vormen die de eerste versie miste", () => {
    // de aanroepnamen staan in stukken, zodat de git-scrub-poortstap deze voorbeeldregels niet voor echte aanroepen aanziet
    const voorbeelden = ["ru" + 'n(["git", "status"])', "ex" + 'ecSync("git status")', "await $" + "`git status`", 'const cmd = ["git", "-C", x]; sp' + "awnSync(cmd)", '{ cmd: ["git", "diff"] }', "ex" + "ecSync(`git diff ${x}`)"];
    for (const r of voorbeelden) expect(TS_GIT.test(r), r).toBe(true);
    for (const r of ["const gitHard = 1", "// git status", "gitArgs(args)"]) expect(TS_GIT.test(r), r).toBe(false);
  });

  const scanTs = (): string[] => {
    const fout: string[] = [];
    for (const pad of bronnen(LEAD, /\.(ts|js)$/)) {
      if (path.basename(pad) === "git-hard.ts") continue;
      for (const { tekst, nr } of regels(pad)) {
        if (/^\s*(\/\/|\*|\/\*)/.test(tekst)) continue;
        if (!TS_GIT.test(tekst)) continue;
        if (tekst.includes("gitArgs(") || uitgezonderd(pad, tekst)) continue;
        fout.push(`${rel(pad)}:${nr}: ${tekst.trim()}`);
      }
    }
    return fout;
  };
  test("elke string 'git' in TS/JS-bron (alle aanroepvormen) staat in git-hard.ts of op een regel met gitArgs(", () => {
    expect(scanTs()).toEqual([]);
  });

  const scanSh = (): { fout: string[]; gezien: number } => {
    const fout: string[] = [];
    let gezien = 0;
    for (const pad of bronnen(LEAD, /\.(sh|py)$/)) {
      for (const { tekst, nr } of regels(pad)) {
        if (/^\s*#/.test(tekst)) continue;
        const aanroep = /\b(check_output|check_call|Popen|os\.system|os\.popen)\b/.test(tekst) || /subprocess\.\w+\(/.test(tekst) || /^\s*git\s/.test(tekst);
        if (ALLEEN_AANROEPEN.includes(rel(pad)) && !aanroep) continue;
        const git = /(^|[\s|&;(`])git\s+(-C|-c|--|[a-z]|"\$@")/.test(tekst) || /["']git["']/.test(tekst) || /\b(check_output|check_call|Popen|os\.system|os\.popen)\b/.test(tekst) || /subprocess\.\w+\(/.test(tekst);
        if (!git) continue;
        if (uitgezonderd(pad, tekst)) continue;
        // Een zin in een echo/fout-tekst of een gebruiksregel is geen aanroep.
        if (/^\s*(echo|printf|fout|log|meld)\b/.test(tekst) || /\bfout\s+["']/.test(tekst)) continue;
        gezien++;
        if (!OPTIES.every((o) => tekst.includes(o))) fout.push(`${rel(pad)}:${nr}: ${tekst.trim()}`);
      }
    }
    return { fout, gezien };
  };
  test("elke git-aanroep in een .sh of .py in scripts/lead draagt de vier opties, of staat als uitzondering met reden in deze test", () => {
    const { fout, gezien } = scanSh();
    expect(gezien).toBeGreaterThanOrEqual(5);
    expect(fout).toEqual([]);
  });

  test("elke uitzondering in de bronscan wijst naar een bestaand bestand en heeft een reden", () => {
    for (const u of UITZONDERING) {
      expect(existsSync(path.join(LEAD, u.bestand)), u.bestand).toBe(true);
      expect(u.reden.trim().length).toBeGreaterThan(10);
    }
    // elke uitzondering moet nog iets uitzonderen: een dode uitzondering is een gat voor een latere aanroep
    treffers.clear();
    scanTs();
    scanSh();
    const dood = UITZONDERING.filter((u) => !treffers.get(u)).map((u) => `${u.bestand}: "${u.bevat}"`);
    expect(dood, `uitzonderingen zonder treffer: ${dood.join("; ")}`).toEqual([]);
  });
});

describe("gitHard en replace-refs", () => {
  test("een refs/replace-ref van een werker verandert niets aan wat gitHard ziet (GIT_NO_REPLACE_OBJECTS=1)", () => {
    const repo = path.join(dir, "replace-repo");
    mkdirSync(repo);
    rauw(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a"), "a");
    rauw(repo, "add", "a");
    rauw(repo, "commit", "-q", "-m", "een");
    const een = rauw(repo, "rev-parse", "HEAD");
    writeFileSync(path.join(repo, "b"), "b");
    rauw(repo, "add", "b");
    rauw(repo, "commit", "-q", "-m", "twee");
    const twee = rauw(repo, "rev-parse", "HEAD");
    // de aanval: `twee` wordt in de ogen van git een commit zonder ouder
    const boom = rauw(repo, "rev-parse", `${twee}^{tree}`);
    const los = rauw(repo, "commit-tree", boom, "-m", "los");
    rauw(repo, "replace", twee, los);
    expect(Bun.spawnSync(["git", "-C", repo, "merge-base", "--is-ancestor", een, twee], { env: env() }).exitCode).toBe(1); // git liegt
    expect(gitHard(repo, ["merge-base", "--is-ancestor", een, twee]).code).toBe(0); // gitHard niet
  });

  test("gitHard zet core.commitGraph uit (een schrijfbare commit-graph laat merge-base liegen)", () => {
    const repo = path.join(dir, "graaf-repo");
    mkdirSync(repo);
    rauw(repo, "init", "-q", "-b", "main");
    expect(gitHard(repo, ["config", "--get", "core.commitGraph"]).uit).toBe("false");
    expect(GIT_HARD_OPTIES).toContain("core.commitGraph=false");
  });
});
