import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../../test-integriteit";
import { type Rec, nieuwRecord, recordPad, schrijfRecord } from "./register";
import { type Rij, duur, gitInfo, status } from "./status";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let dir: string;
let staat: string;
const env = () => ({ LAB_LEAD_STAAT: staat, HOME: dir });

function maak(id: string, extra: Partial<Rec>): void {
  schrijfRecord(staat, { ...nieuwRecord(id, { LAB_AGENT_NAAM: id, LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "lead" }, "/w/x", T0), ...extra });
}
function json(argv: string[], nu: number): Rij[] {
  return JSON.parse(status(["--json", ...argv], env(), nu).stdout);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-status-"));
  staat = join(dir, "staat");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lead status", () => {
  test("lege staat: nette melding en exit 0", () => {
    const u = status([], env(), T0);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("geen sessies");
    expect(JSON.parse(status(["--json"], env(), T0).stdout)).toEqual([]);
  });

  test("toont sessies met subagent eronder; weg alleen met --alles", () => {
    maak("w2", { toestand: "klaar", sinds: T0 - 4 * MIN, laatste_tool: "SendMessage", rapport_om: T0 - 4 * MIN, opdracht: "/a/b/c/w2/OPDRACHT.md" });
    maak("lead-hooks", { rol: "sublead", toestand: "bezig", sinds: T0 - 12_000, laatste_tool: "Bash", laatste_tool_om: T0 - 12_000 });
    maak("sa1", { soort: "subagent", ouder: "lead-hooks", agent_type: "general-purpose", toestand: "bezig", laatste_tool: "Edit", laatste_tool_om: T0 - MIN, start: T0 - 2 * MIN, sinds: T0 - 2 * MIN });
    maak("sa0", { soort: "subagent", ouder: "lead-hooks", toestand: "klaar", einde: T0 - MIN });
    maak("oud", { toestand: "weg", einde: T0 - MIN });
    const u = status([], env(), T0).stdout;
    expect(u).toContain("w2");
    expect(u).toContain("klaar ✓");
    expect(u).toContain("└ sa1");
    expect(u).toContain("general-purpose");
    expect(u).not.toContain("sa0");
    expect(u).not.toContain("oud");
    expect(u).toContain("…/w2/OPDRACHT.md");
    expect(json([], T0).map((r) => r.id)).toEqual(["lead-hooks", "w2"]);
    const alles = json(["--alles"], T0);
    expect(alles.map((r) => r.id)).toContain("oud");
    expect(alles.find((r) => r.id === "lead-hooks")?.kinderen.map((k) => k.id)).toEqual(["sa1", "sa0"]);
  });

  test("vastgelopen: bezig > 20 min zonder tool, goedkeuring > 10 min; kinderen die werken tellen als leven", () => {
    maak("a", { toestand: "bezig", sinds: T0 - 30 * MIN, laatste_tool_om: T0 - 27 * MIN });
    maak("b", { toestand: "bezig", sinds: T0 - 30 * MIN, laatste_tool_om: T0 - 5 * MIN });
    maak("c", { toestand: "goedkeuring", sinds: T0 - 11 * MIN });
    maak("d", { toestand: "goedkeuring", sinds: T0 - 9 * MIN });
    maak("e", { toestand: "bezig", sinds: T0 - 30 * MIN, laatste_tool_om: T0 - 30 * MIN });
    maak("ek", { soort: "subagent", ouder: "e", toestand: "bezig", sinds: T0 - 40_000, laatste_tool_om: T0 - 40_000 });
    maak("f", { toestand: "idle", sinds: T0 - 300 * MIN });
    const v = Object.fromEntries(json([], T0).map((r) => [r.id, r.vastgelopen]));
    expect(v).toEqual({ a: true, b: false, c: true, d: false, e: false, f: false });
    expect(status([], env(), T0).stdout).toMatch(/a\s+agent\s+lead\s+bezig \?/);
  });

  test("--lead filtert; onbekende optie geeft exit 1", () => {
    maak("a", { lead: "lead1" });
    maak("b", { lead: "lead2" });
    expect(json(["--lead", "lead2"], T0).map((r) => r.id)).toEqual(["b"]);
    const u = status(["--bogus"], env(), T0);
    expect(u.code).toBe(1);
    expect(u.stderr).toContain("onbekende optie");
    expect(status(["--lead"], env(), T0).code).toBe(1);
  });

  test("ruimt records met toestand weg ouder dan 24 u op, laat jongere staan; kapotte records geven geen crash", () => {
    maak("oud", { toestand: "weg", einde: T0 - 25 * 3600_000 });
    maak("jong", { toestand: "weg", einde: T0 - 23 * 3600_000 });
    maak("oudsub", { soort: "subagent", ouder: "x", toestand: "klaar", einde: T0 - 26 * 3600_000 });
    writeFileSync(join(staat, "register", "kapot.json"), "{ niet json");
    json([], T0);
    expect(existsSync(recordPad(staat, "oud"))).toBe(false);
    expect(existsSync(recordPad(staat, "oudsub"))).toBe(false);
    expect(existsSync(recordPad(staat, "jong"))).toBe(true);
  });

  test("duur", () => {
    expect([duur(12_000), duur(4 * MIN), duur(3 * 3600_000), duur(2 * 86400_000)]).toEqual(["12s", "4m", "3u", "2d"]);
  });
});

describe("--git", () => {
  function git(cwd: string, ...args: string[]) {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: schoneEnv(), stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString();
  }

  test("schoon/vuil, tak, in origin/main; ontbrekende map = worktree weg", () => {
    const bare = join(dir, "origin.git");
    const wc = join(dir, "wc");
    mkdirSync(wc);
    git(dir, "init", "--bare", "-b", "main", bare);
    git(wc, "init", "-b", "main");
    git(wc, "config", "user.email", "t@t");
    git(wc, "config", "user.name", "t");
    writeFileSync(join(wc, "a"), "1");
    git(wc, "add", ".");
    git(wc, "commit", "-m", "een");
    git(wc, "remote", "add", "origin", bare);
    git(wc, "push", "-u", "origin", "main");
    git(wc, "switch", "-c", "tak");
    writeFileSync(join(wc, "b"), "2");
    git(wc, "add", ".");
    git(wc, "commit", "-m", "twee");

    expect(gitInfo(wc)).toEqual({ bestaat: true, schoon: true, tak: "tak", in_main: false });
    git(wc, "push", "origin", "tak:main");
    git(wc, "fetch", "origin");
    writeFileSync(join(wc, "c"), "3");
    expect(gitInfo(wc)).toEqual({ bestaat: true, schoon: false, tak: "tak", in_main: true });
    expect(gitInfo(join(dir, "weg"))).toEqual({ bestaat: false, schoon: null, tak: null, in_main: null });

    maak("w2", { cwd: wc, toestand: "vrij" });
    maak("w3", { cwd: join(dir, "weg") });
    const rijen = json(["--git"], T0);
    expect(rijen.find((r) => r.id === "w2")?.git?.in_main).toBe(true);
    const tekst = status(["--git"], env(), T0).stdout;
    expect(tekst).toContain("vuil tak in main");
    expect(tekst).toContain("worktree weg");
    // zonder --git geen git-veld
    expect(json([], T0)[0].git).toBeUndefined();
  });
});

describe("status.sh", () => {
  const SH = join(import.meta.dir, "..", "status.sh");
  function draai(argv: string[], extra: Record<string, string> = {}) {
    const p = Bun.spawnSync(["/bin/sh", SH, ...argv], { env: { ...schoneEnv(), PATH: process.env.PATH ?? "/usr/bin:/bin", LAB_LEAD_STAAT: staat, HOME: dir, ...extra }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test("--json met ontbrekend register: geldige JSON ([]), exit 0", () => {
    const r = draai(["--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  test("--json met leeg register en met kapotte of lege recordbestanden: geldige JSON ([])", () => {
    mkdirSync(join(staat, "register"), { recursive: true });
    expect(JSON.parse(draai(["--json"]).out)).toEqual([]);
    writeFileSync(join(staat, "register", "leeg.json"), "");
    writeFileSync(join(staat, "register", "kapot.json"), "{ half");
    const r = draai(["--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  test("zonder --json is de uitvoer tekst (niet voor een JSON-parser bedoeld)", () => {
    const r = draai([]);
    expect(r.out).toBe("geen sessies in het register\n");
  });

  test("verdwenen LAB_LEAD_BUN: terugval op bun uit PATH", () => {
    const r = draai(["--json"], { LAB_LEAD_BUN: join(dir, "Cellar/bun/0/bin/bun") });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  test("geen bun te vinden: stderr-melding, exit 127, lege stdout", () => {
    const r = draai(["--json"], { PATH: "/nergens", LAB_LEAD_BUN: join(dir, "bestaat-niet") });
    expect(r.code).toBe(127);
    expect(r.out).toBe("");
    expect(r.err).toContain("bun niet gevonden");
  });
});
