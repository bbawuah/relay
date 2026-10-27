import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../test-integriteit";

// Wegwerp-repo's: een lokale bare origin, de checkout van de lead en een worktree van een werker. Geen netwerk, geen echte sessies.
// De pre-push-hook van de lead-repo schrijft een markerbestand: na een push met push-werker.sh bestaat dat niet.

const SCRIPT = join(import.meta.dir, "push-werker.sh");
let dir: string;
let origin: string;
let lead: string;
let wt: string;
let staat: string;
let marker: string;

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: { ...schoneEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
const uit = (cwd: string, ...args: string[]) => git(cwd, ...args).stdout.toString().trim();
const commit = (cwd: string, naam: string) => {
  writeFileSync(join(cwd, naam), naam);
  git(cwd, "add", naam);
  git(cwd, "commit", "-q", "-m", naam);
  return uit(cwd, "rev-parse", "HEAD");
};
const push = (args: string[], opties: { cwd?: string; rol?: string | null } = {}) => {
  const env: Record<string, string> = { ...schoneEnv(), LAB_LEAD_STAAT: staat, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  delete env.LAB_AGENT_ROL;
  if (opties.rol !== null) env.LAB_AGENT_ROL = opties.rol ?? "lead";
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], { cwd: opties.cwd ?? lead, env });
  return { code: r.exitCode, uit: r.stdout.toString(), fout: r.stderr.toString() };
};
// De identiteit die spawn.sh bij de start schrijft: <staat>/identiteit/<sha256(realpath(worktree)) eerste 24 hex>.json met de tak.
const schrijfId = (pad: string, inhoud: object) => {
  const hash = new Bun.CryptoHasher("sha256").update(realpathSync(pad)).digest("hex").slice(0, 24);
  mkdirSync(join(staat, "identiteit"), { recursive: true });
  writeFileSync(join(staat, "identiteit", `${hash}.json`), JSON.stringify(inhoud));
};
const remote = (tak: string) => uit(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${tak}`);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "push-werker-")));
  origin = join(dir, "origin.git");
  lead = join(dir, "lead");
  staat = join(dir, "staat");
  marker = join(dir, "hook-draaide");
  mkdirSync(lead);
  git(dir, "init", "-q", "--bare", origin);
  git(lead, "init", "-q", "-b", "main");
  commit(lead, "begin");
  git(lead, "remote", "add", "origin", origin);
  git(lead, "push", "-q", "origin", "main");
  // de pre-push-hook van de lead-repo: bewijs dat hij niet draait
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(lead, "config", "core.hooksPath", hooks);
  wt = join(dir, "werker");
  git(lead, "worktree", "add", "-q", "-b", "werk", wt);
  schrijfId(wt, { naam: "w", tak: "werk" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("push-werker.sh", () => {
  test("pusht <sha> naar een nieuwe tak met een expliciete refspec; de pre-push-hook draait niet; de melding noemt de overgeslagen poort", () => {
    const sha = commit(wt, "werk.txt");
    const r = push([wt, sha, "werk"]);
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(remote("werk")).toBe(sha);
    expect(r.fout).toMatch(/pre-push-poort wordt bewust overgeslagen/);
    expect(r.fout).toMatch(/CI-check 'poort'/);
    // controle dat de hook zonder het script wel zou draaien (anders bewijst de marker niets)
    const sha2 = commit(wt, "meer.txt");
    git(lead, "push", "origin", `${sha2}:refs/heads/werk`);
    expect(existsSync(marker)).toBe(true);
  });

  test("een fast-forward van een bestaande tak slaagt", () => {
    const s1 = commit(wt, "een.txt");
    expect(push([wt, s1, "werk"]).code).toBe(0);
    const s2 = commit(wt, "twee.txt");
    expect(push([wt, s2, "werk"]).code).toBe(0);
    expect(remote("werk")).toBe(s2);
    expect(existsSync(marker)).toBe(false);
  });

  test("weigert zonder LAB_AGENT_ROL=lead (ook met een andere rol)", () => {
    const sha = commit(wt, "werk.txt");
    for (const rol of [null, "agent", "sublead"]) {
      const r = push([wt, sha, "werk"], { rol });
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/alleen de lead/);
    }
    expect(remote("werk")).toBe("");
  });

  test("weigert main en master", () => {
    const sha = commit(wt, "werk.txt");
    for (const tak of ["main", "master"]) {
      const r = push([wt, sha, tak]);
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/niet toegestaan/);
    }
    expect(remote("main")).not.toBe(sha);
  });

  test("weigert een tak die niet de tak van de werker-worktree is", () => {
    const sha = commit(wt, "werk.txt");
    const r = push([wt, sha, "andere"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/spawn legde de tak 'werk' vast .* niet 'andere'/);
    expect(remote("andere")).toBe("");
  });

  test("weigert een verkeerde sha (niet de HEAD van de werker), een afgekorte sha en een onbekende worktree", () => {
    const eerste = commit(wt, "een.txt");
    const tweede = commit(wt, "twee.txt");
    const r = push([wt, eerste, "werk"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet op de gemelde/);
    expect(push([wt, tweede.slice(0, 10), "werk"]).fout).toMatch(/volledige sha/);
    expect(push([join(dir, "bestaat-niet"), tweede, "werk"]).fout).toMatch(/worktree bestaat niet/);
    expect(push([dir, tweede, "werk"]).fout).toMatch(/niet \(eenduidig\) in git worktree list/);
    expect(remote("werk")).toBe("");
  });

  test("weigert een non-fast-forward van origin/<tak> (geen force)", () => {
    const sha = commit(wt, "werk.txt");
    // origin/werk wijst naar een eigen, andere geschiedenis
    const ander = join(dir, "ander");
    mkdirSync(ander);
    git(ander, "init", "-q", "-b", "main");
    commit(ander, "los");
    git(ander, "push", "-q", origin, "HEAD:refs/heads/werk");
    const voor = remote("werk");
    const r = push([wt, sha, "werk"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/geen fast-forward/);
    expect(remote("werk")).toBe(voor);
  });

  test("weigert met de cwd in de worktree van de werker (ook een submap) en in een map met een werker-identiteit", () => {
    const sha = commit(wt, "werk.txt");
    const r = push([wt, sha, "werk"], { cwd: wt });
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/in de worktree van de werker/);
    mkdirSync(join(wt, "sub"));
    expect(push([wt, sha, "werk"], { cwd: join(wt, "sub") }).fout).toMatch(/in de worktree van de werker/);
    // een tweede worktree met een identiteit (spawn.sh --vendor codex) is ook een werker
    const andere = join(dir, "andere-werker");
    git(lead, "worktree", "add", "-q", "-b", "twee", andere);
    schrijfId(andere, {});
    const r2 = push([wt, sha, "werk"], { cwd: andere });
    expect(r2.code).toBe(1);
    expect(r2.fout).toMatch(/worktree van een werker/);
    expect(remote("werk")).toBe("");
  });

  test("weigert als de identiteit geen tak vastlegt of een andere tak (ook als HEAD en de tak zelf kloppen)", () => {
    const sha = commit(wt, "werk.txt");
    schrijfId(wt, { naam: "w" });
    expect(push([wt, sha, "werk"]).fout).toMatch(/legt geen tak vast/);
    schrijfId(wt, { naam: "w", tak: "andere" });
    expect(push([wt, sha, "werk"]).fout).toMatch(/legde de tak 'andere' vast/);
    rmSync(join(staat, "identiteit"), { recursive: true });
    expect(push([wt, sha, "werk"]).fout).toMatch(/geen identiteit voor/);
    expect(remote("werk")).toBe("");
  });

  test("weigert als de werker <gitdir>/HEAD naar een andere tak heeft gezet", () => {
    const sha = commit(wt, "werk.txt");
    git(lead, "branch", "andere");
    const gitdir = uit(wt, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/andere\n");
    const r = push([wt, sha, "werk"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/HEAD van .* wijst naar 'ref: refs\/heads\/andere'/);
    expect(remote("werk")).toBe("");
  });

  test("een refs/replace-ref kan de fast-forward-toets niet misleiden (aanval: wees-commit vervangen door origin/<tak>)", () => {
    // origin/werk staat op een eigen geschiedenis; de werker maakt een wees-commit en een replace-ref die hem in de ogen van
    // `merge-base --is-ancestor` laat afstammen van die tip. Met GIT_NO_REPLACE_OBJECTS is het geen fast-forward en weigert het script.
    const ander = join(dir, "ander");
    mkdirSync(ander);
    git(ander, "init", "-q", "-b", "main");
    const tip = commit(ander, "los");
    git(ander, "push", "-q", origin, "HEAD:refs/heads/werk");
    git(lead, "fetch", "-q", "origin", "werk");
    const sha = commit(wt, "werk.txt");
    const boom = uit(wt, "rev-parse", `${sha}^{tree}`);
    // replace: de ouder van <sha> lijkt origin/werk te zijn
    const nep = uit(wt, "commit-tree", boom, "-p", tip, "-m", "nep");
    git(wt, "replace", sha, nep);
    // controle dat de aanval werkt: zonder GIT_NO_REPLACE_OBJECTS zegt git dat <sha> van de tip afstamt
    expect(git(wt, "merge-base", "--is-ancestor", tip, sha).exitCode).toBe(0);
    const r = push([wt, sha, "werk"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/geen fast-forward/);
    expect(remote("werk")).toBe(tip);
  });

  test("--droog toetst alles maar pusht niet", () => {
    const sha = commit(wt, "werk.txt");
    const r = push(["--droog", wt, sha, "werk"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain(`droog: git push origin ${sha}:refs/heads/werk`);
    expect(remote("werk")).toBe("");
  });
});
