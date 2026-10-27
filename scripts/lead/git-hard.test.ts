import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schoneEnv } from "../test-integriteit";
import { GIT_HARD_OPTIES, gitArgs, gitHard } from "./git-hard";
import { gitInfo } from "./hooks/status";

// Een wegwerprepo met de aanval uit de review van #679: in de worktree van een werker staat `sub/.git` (een bestand met
// `gitdir:` naar een eigen map met een config met core.fsmonitor), een gitlink in de index, en een relatief core.hooksPath
// met een hook van de werker. Elke hook of fsmonitor schrijft een markeerbestand; de geharde helper mag er geen laten ontstaan.

let dir: string;
let wt: string;
let evil: string;
let markFsmonitor: string;
let markHook: string;

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
  dir = mkdtempSync(path.join(tmpdir(), "git-hard-"));
  markFsmonitor = path.join(dir, "MARK-FSMONITOR");
  markHook = path.join(dir, "MARK-HOOK");
  const hoofd = path.join(dir, "hoofd");
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
  mkdirSync(path.join(wt, "sub"));
  writeFileSync(path.join(wt, "sub", ".git"), `gitdir: ${path.join(evil, ".git")}\n`);
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
});

describe("gitHard", () => {
  test("status, rev-parse, merge-base, diff en log in de worktree laten geen markeerbestand achter", () => {
    const hoofd = rauw(wt, "rev-parse", "HEAD");
    rmSync(markFsmonitor, { force: true });
    const uitslagen = [
      gitHard(wt, ["status", "--porcelain"]),
      gitHard(wt, ["rev-parse", "--abbrev-ref", "HEAD"]),
      gitHard(wt, ["merge-base", "--is-ancestor", "HEAD", "main"]),
      gitHard(wt, ["diff", "--stat"]),
      gitHard(wt, ["log", "-1", "--format=%H"]),
    ];
    expect(uitslagen.map((u) => u.code)).toEqual([0, 0, 0, 0, 0]);
    expect(uitslagen[4]?.uit).toBe(hoofd);
    expect(gemerkt(markFsmonitor)).toBe(false);
    expect(gemerkt(markHook)).toBe(false);
  });

  test("status krijgt --ignore-submodules=all en de gitlink verschijnt niet als wijziging", () => {
    expect(gitArgs(["status", "--porcelain"]).slice(-3)).toEqual(["status", "--ignore-submodules=all", "--porcelain"]);
    expect(gitArgs(["log", "-1"])).not.toContain("--ignore-submodules=all");
    const u = gitHard(wt, ["status", "--porcelain"]);
    expect(u.uit).not.toContain("sub");
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

  test("worktree remove van een werker-worktree via de helper voert niets uit", () => {
    const hoofd = rauw(wt, "rev-parse", "--git-common-dir");
    const r = gitHard(path.dirname(hoofd), ["worktree", "remove", wt]);
    expect(typeof r.code).toBe("number"); // mag falen (vies); het gaat om wat er NIET draait
    expect(gemerkt(markFsmonitor)).toBe(false);
    expect(gemerkt(markHook)).toBe(false);
  });

  test("gitInfo van lead status (hooks/status.ts) voert de fsmonitor niet uit", () => {
    const g = gitInfo(wt);
    expect(g.bestaat).toBe(true);
    expect(g.tak).toBe("werker");
    expect(gemerkt(markFsmonitor)).toBe(false);
  });

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

describe("mutatietest: de test is rood als de helper een optie mist", () => {
  test("zonder -c core.fsmonitor= verschijnt het markeerbestand wel (diff, waar --ignore-submodules niet helpt)", () => {
    gitHard(wt, ["diff", "--stat"], { zonder: ["core.fsmonitor="] });
    expect(gemerkt(markFsmonitor)).toBe(true);
  });

  test("zonder --ignore-submodules=all én zonder -c core.fsmonitor= verschijnt het markeerbestand bij status", () => {
    gitHard(wt, ["status", "--porcelain"], { zonder: ["core.fsmonitor=", "--ignore-submodules=all"] });
    expect(gemerkt(markFsmonitor)).toBe(true);
  });

  test("--ignore-submodules=all alleen houdt status al schoon (verdediging in de diepte)", () => {
    gitHard(wt, ["status", "--porcelain"], { zonder: ["core.fsmonitor="] });
    expect(gemerkt(markFsmonitor)).toBe(false);
  });

  test("zonder -c core.hooksPath=/dev/null draait de hook van de werker wel", () => {
    gitHard(wt, ["commit", "-q", "--allow-empty", "-m", "x"], { env: env(), zonder: ["core.hooksPath=/dev/null"] });
    expect(gemerkt(markHook)).toBe(true);
  });

  test("de opties staan allemaal in GIT_HARD_OPTIES", () => {
    expect(GIT_HARD_OPTIES).toEqual(["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false"]);
  });
});

describe("bronscan: git in de lead-tooling loopt via de helper", () => {
  const LEAD = import.meta.dir;
  const bronnen = (map: string): string[] =>
    readdirSync(map, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(map, e.name);
      if (e.isDirectory()) return e.name === "fixtures" || e.name === "codex-fixtures" || e.name === "commando" || e.name === "node_modules" ? [] : bronnen(p);
      return /\.(ts|js)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
    });
  const regels = (pad: string) => readFileSync(pad, "utf8").split("\n").map((tekst, i) => ({ tekst, nr: i + 1 }));

  test("geen TS- of JS-bron start git zelf, behalve git-hard.ts; installeer-grens gebruikt gitArgs", () => {
    const fout: string[] = [];
    for (const pad of bronnen(LEAD)) {
      if (path.basename(pad) === "git-hard.ts") continue;
      for (const { tekst, nr } of regels(pad)) {
        if (/^\s*(\/\/|\*)/.test(tekst)) continue;
        if (/(spawn|spawnSync|exec|execFile|execFileSync)\(\s*\[?\s*["'`]git["'`]/.test(tekst) && !tekst.includes("gitArgs(")) fout.push(`${path.relative(LEAD, pad)}:${nr}: ${tekst.trim()}`);
        if (/["'`]git["'`]\s*,\s*\[?\s*["'`]-C["'`]/.test(tekst) && !tekst.includes("gitArgs(")) fout.push(`${path.relative(LEAD, pad)}:${nr}: ${tekst.trim()}`);
      }
    }
    expect(fout).toEqual([]);
  });

  test("grenzen.sh: elke git-aanroep in python draagt de drie opties", () => {
    const aanroepen = regels(path.join(LEAD, "hooks", "grenzen.sh")).filter((r) => /subprocess\.run\(\["git",/.test(r.tekst));
    expect(aanroepen.length).toBeGreaterThanOrEqual(2);
    for (const r of aanroepen) {
      expect(r.tekst).toContain('"core.fsmonitor="');
      expect(r.tekst).toContain('"core.hooksPath=/dev/null"');
      expect(r.tekst).toContain('"core.untrackedCache=false"');
    }
  });

  test("spawn.sh: elke git met -C of -c draagt de drie opties (git_schoon voegt ze toe)", () => {
    const aanroepen = regels(path.join(LEAD, "spawn.sh")).filter((r) => !/^\s*#/.test(r.tekst) && /(^|[\s(`;|&])git\s+(-C|-c)\b/.test(r.tekst));
    expect(aanroepen.length).toBeGreaterThanOrEqual(3);
    for (const r of aanroepen) {
      expect(r.tekst, `spawn.sh:${r.nr}`).toContain("core.fsmonitor=");
      expect(r.tekst, `spawn.sh:${r.nr}`).toContain("core.hooksPath=/dev/null");
      expect(r.tekst, `spawn.sh:${r.nr}`).toContain("core.untrackedCache=false");
    }
    expect(regels(path.join(LEAD, "spawn.sh")).filter((r) => /^\s*git_schoon -C/.test(r.tekst)).length).toBeGreaterThanOrEqual(1);
  });
  // Bewust niet gehard (geen werker-map): push.sh (draait in de eigen worktree van wie pusht en zet zelf de hooks van die
  // worktree aan) en merge.sh (`git patch-id` leest stdin, geen repo). Zie AGENTS.md.
});
