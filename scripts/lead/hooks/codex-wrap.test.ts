import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../../test-integriteit";
import { IDENTITEIT_SLEUTELS, cwdUitInvoer, hookOmgeving, identiteitEnv, sessieUitInvoer } from "./codex-wrap";
import { IDENTITEIT_MAX_MS, identiteitPad, leesIdentiteit, schrijfIdentiteit, ververseIdentiteit, wisIdentiteit } from "./register";

const WRAP = join(import.meta.dir, "codex-wrap.sh");
const GRENZEN = join(import.meta.dir, "grenzen.sh");
let dir: string;
let staat: string;
let werk: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-wrap-")));
  staat = join(dir, "staat");
  werk = join(dir, "worktree");
  mkdirSync(join(werk, "sub/diep"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ident = { naam: "cx1", rol: "agent", lead: "lead-x", opdracht: "/o/OPDRACHT.md", spawn_id: "sp-1", ts: Date.now(), t3_thread: "mcp:abc" };
const hookEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: "/usr/bin:/bin", HOME: dir, LAB_LEAD_BUN: process.execPath, ...extra });

function draai(env: Record<string, string>, invoer: object, cmd = ['echo "ROL=$LAB_AGENT_ROL NAAM=$LAB_AGENT_NAAM LEAD=$LAB_LEAD_NAAM T3=$LAB_T3_THREAD"; cat']) {
  const p = Bun.spawnSync(["/bin/sh", WRAP, "/bin/sh", "-c", ...cmd], { env, stdin: new TextEncoder().encode(JSON.stringify(invoer)), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("identiteitEnv", () => {
  test("zoekt vanaf de cwd omhoog; een submap van de checkout vindt de identiteit", () => {
    schrijfIdentiteit(staat, werk, ident);
    const e = identiteitEnv({ LAB_LEAD_STAAT: staat }, join(werk, "sub/diep"));
    expect(e).toMatchObject({ LAB_AGENT_NAAM: "cx1", LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "lead-x", LAB_SPAWN_ID: "sp-1", LAB_T3_THREAD: "mcp:abc" });
  });
  test("een andere checkout of geen cwd: niets erbij", () => {
    schrijfIdentiteit(staat, werk, ident);
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, join(dir, "andere"))).toEqual({});
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, "")).toEqual({});
  });
  test("een kapot identiteitsbestand geeft niets", () => {
    schrijfIdentiteit(staat, werk, ident);
    writeFileSync(join(staat, "identiteit", Bun.spawnSync(["ls", join(staat, "identiteit")]).stdout.toString().trim()), "{kapot");
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, werk)).toEqual({});
  });
  test("een identiteit verloopt na IDENTITEIT_MAX_MS en zonder ts is hij ongeldig", () => {
    schrijfIdentiteit(staat, werk, { ...ident, ts: 1000 });
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, werk, 1000 + IDENTITEIT_MAX_MS)).toMatchObject({ LAB_AGENT_ROL: "agent" });
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, werk, 1001 + IDENTITEIT_MAX_MS)).toEqual({});
    writeFileSync(identiteitPad(staat, werk), JSON.stringify({ naam: "x", rol: "agent" }));
    expect(leesIdentiteit(staat, werk)).toBeNull();
  });
  test("het bestand is 0600 in een map 0700", () => {
    schrijfIdentiteit(staat, werk, ident);
    expect(statSync(identiteitPad(staat, werk)).mode & 0o777).toBe(0o600);
    expect(statSync(join(staat, "identiteit")).mode & 0o777).toBe(0o700);
  });
  test("wisIdentiteit haalt alleen de identiteit van dezelfde spawn weg", () => {
    schrijfIdentiteit(staat, werk, ident);
    wisIdentiteit(staat, join(werk, "sub"), "andere-spawn");
    expect(leesIdentiteit(staat, werk)).not.toBeNull();
    wisIdentiteit(staat, join(werk, "sub"), "sp-1");
    expect(leesIdentiteit(staat, werk)).toBeNull();
  });
  test("Z1: een identiteit met rol lead (of een onbekende of lege rol), zonder naam of met een ts uit de toekomst is ongeldig", () => {
    for (const rol of ["lead", "", "root", "Agent"]) {
      schrijfIdentiteit(staat, werk, { ...ident, rol });
      expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, werk)).toEqual({});
    }
    for (const rol of ["agent", "sublead", "vervolg", "lead-proef"]) {
      schrijfIdentiteit(staat, werk, { ...ident, rol });
      expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, werk)).toMatchObject({ LAB_AGENT_ROL: rol });
    }
    schrijfIdentiteit(staat, werk, { ...ident, naam: "" });
    expect(leesIdentiteit(staat, werk)).toBeNull();
    schrijfIdentiteit(staat, werk, { ...ident, ts: Date.now() + 3600_000 });
    expect(leesIdentiteit(staat, werk)).toBeNull();
  });
  test("Z1: een symlink, een bestand met groeps- of wereldrechten of een map met te ruime rechten geldt niet", () => {
    schrijfIdentiteit(staat, werk, ident);
    const pad = identiteitPad(staat, werk);
    chmodSync(pad, 0o640);
    expect(leesIdentiteit(staat, werk)).toBeNull();
    chmodSync(pad, 0o600);
    expect(leesIdentiteit(staat, werk)).not.toBeNull();
    chmodSync(join(staat, "identiteit"), 0o755);
    expect(leesIdentiteit(staat, werk)).toBeNull();
    chmodSync(join(staat, "identiteit"), 0o700);
    const echt = join(dir, "echt.json");
    writeFileSync(echt, readFileSync(pad), { mode: 0o600 });
    rmSync(pad);
    symlinkSync(echt, pad);
    expect(leesIdentiteit(staat, werk)).toBeNull();
  });
  test("Z1: ververseIdentiteit zet ts op nu voor dezelfde spawn (een lange sessie verloopt niet na 12 u); niet voor een andere spawn of binnen een minuut", () => {
    const t0 = Date.now();
    schrijfIdentiteit(staat, werk, { ...ident, ts: t0 - 11 * 3600_000 });
    ververseIdentiteit(staat, werk, "andere-spawn", t0);
    expect(leesIdentiteit(staat, werk, t0)?.ts).toBe(t0 - 11 * 3600_000);
    ververseIdentiteit(staat, werk, "sp-1", t0);
    expect(leesIdentiteit(staat, werk, t0 + 11 * 3600_000)?.ts).toBe(t0);
    ververseIdentiteit(staat, werk, "sp-1", t0 + 30_000); // < 1 minuut later: geen schrijfactie
    expect(leesIdentiteit(staat, werk, t0 + 30_000)?.ts).toBe(t0);
    expect(statSync(identiteitPad(staat, werk)).mode & 0o777).toBe(0o600);
  });
  test("Z2: hookOmgeving haalt zonder identiteit alle identiteitssleutels uit de omgeving (daemon-omgeving van een andere sessie), met identiteit wint het bestand", () => {
    const daemon = { PATH: "/bin", LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: "dode-werker", LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "l", LAB_OPDRACHT: "/o", LAB_SPAWN_ID: "oud", LAB_T3_THREAD: "oud" };
    const zonder = hookOmgeving(daemon, join(dir, "geen-identiteit"));
    expect(zonder.PATH).toBe("/bin");
    for (const k of IDENTITEIT_SLEUTELS) expect(zonder[k]).toBeUndefined();
    schrijfIdentiteit(staat, werk, ident);
    const met = hookOmgeving(daemon, werk);
    expect(met).toMatchObject({ PATH: "/bin", LAB_AGENT_NAAM: "cx1", LAB_AGENT_ROL: "agent", LAB_SPAWN_ID: "sp-1", LAB_T3_THREAD: "mcp:abc" });
  });
  test("hookOmgeving: Brians eigen Codex-sessie (geen identiteit, geen naam of rol) krijgt de afgeleide naam uit het sessie-id; een werker nooit", () => {
    const sid = "01a17ebd-76bc-7472-a451-ac8ef9f536d4";
    const eigen = hookOmgeving({ PATH: "/bin", LAB_LEAD_STAAT: staat }, join(dir, "geen-identiteit"), Date.now(), sid);
    expect(eigen.LAB_AGENT_NAAM).toBe("codex-ac8ef9f536d4");
    expect(eigen.LAB_AGENT_ROL).toBeUndefined();
    expect(eigen.LAB_LEAD_NAAM).toBeUndefined();
    // zonder (geldig) id geen naam
    expect(hookOmgeving({ PATH: "/bin", LAB_LEAD_STAAT: staat }, werk, Date.now(), "").LAB_AGENT_NAAM).toBeUndefined();
    // een daemon-omgeving met naam of rol van een andere (dode) werker: geen afgeleide naam, en de sleutels gaan eruit
    for (const extra of [{ LAB_AGENT_NAAM: "dode-werker" }, { LAB_AGENT_ROL: "agent" }]) {
      const u = hookOmgeving({ PATH: "/bin", LAB_LEAD_STAAT: staat, ...extra }, werk, Date.now(), sid);
      for (const k of IDENTITEIT_SLEUTELS) expect(u[k]).toBeUndefined();
    }
    // een werker met een (nu verlopen) identiteitsbestand: nooit een afgeleide naam
    schrijfIdentiteit(staat, werk, { ...ident, ts: Date.now() - IDENTITEIT_MAX_MS - 1000 });
    expect(hookOmgeving({ PATH: "/bin", LAB_LEAD_STAAT: staat }, werk, Date.now(), sid).LAB_AGENT_NAAM).toBeUndefined();
  });
  test("hookOmgeving: een cwd dat geen absoluut pad is geeft geen afgeleide naam", () => {
    for (const c of ["", "relatief", "../x"]) expect(hookOmgeving({ PATH: "/bin", LAB_LEAD_STAAT: staat }, c, Date.now(), "01a17ebd-76bc-7472-a451-ac8ef9f536d4").LAB_AGENT_NAAM).toBeUndefined();
  });
  test("sessieUitInvoer", () => {
    expect(sessieUitInvoer('{"session_id":"abc"}')).toBe("abc");
    expect(sessieUitInvoer("{kapot")).toBe("");
    expect(sessieUitInvoer('{"session_id":3}')).toBe("");
  });
  test("cwdUitInvoer", () => {
    expect(cwdUitInvoer('{"cwd":"/x"}')).toBe("/x");
    expect(cwdUitInvoer("{kapot")).toBe("");
    expect(cwdUitInvoer('{"cwd":3}')).toBe("");
  });
});

describe("codex-wrap.sh", () => {
  test("T3-thread zonder env: het commando krijgt LAB_AGENT_ROL en de rest uit de identiteit, en de invoer ongewijzigd", () => {
    schrijfIdentiteit(staat, werk, ident);
    const invoer = { cwd: join(werk, "sub"), hook_event_name: "PreToolUse" };
    const r = draai(hookEnv({ LAB_LEAD_STAAT: staat }), invoer);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ROL=agent NAAM=cx1 LEAD=lead-x T3=mcp:abc");
    expect(r.out).toContain(JSON.stringify(invoer));
  });

  test("de identiteit uit het bestand wint van een verouderde daemon-omgeving (Codex-TUI: hooks erven de omgeving van de daemon)", () => {
    schrijfIdentiteit(staat, werk, { naam: "cx1", rol: "agent", lead: "lead-x", opdracht: "/o/OPDRACHT.md", spawn_id: "sp-1", ts: Date.now() });
    const r = draai(hookEnv({ LAB_LEAD_STAAT: staat, LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: "andere-sessie", LAB_LEAD_NAAM: "l", LAB_T3_THREAD: "oud" }), { cwd: werk });
    expect(r.out).toContain("ROL=agent NAAM=cx1 LEAD=lead-x T3=\n");
  });

  test("Z2: zonder identiteit voor deze checkout gaan de identiteitssleutels uit de omgeving (die is van een andere sessie of van Brian zelf)", () => {
    schrijfIdentiteit(staat, werk, ident);
    const r = draai(hookEnv({ LAB_LEAD_STAAT: staat, LAB_AGENT_ROL: "sublead", LAB_AGENT_NAAM: "eigen", LAB_LEAD_NAAM: "l" }), { cwd: join(dir, "andere") });
    expect(r.out).toContain("ROL= NAAM= LEAD= T3=");
  });

  test("zonder identiteit draait het commando ongewijzigd (grenzen.sh moet ook zonder rol werken); exit 2 en stderr gaan door", () => {
    const r = draai(hookEnv({ LAB_LEAD_STAAT: staat }), { cwd: werk }, ['echo "ROL=[$LAB_AGENT_ROL]"; echo geweigerd >&2; exit 2']);
    expect(r.code).toBe(2);
    expect(r.out).toContain("ROL=[]");
    expect(r.err).toContain("geweigerd");
    mkdirSync(join(staat, "identiteit"), { recursive: true });
    expect(draai(hookEnv({ LAB_LEAD_STAAT: staat }), { cwd: werk }, ['echo "ROL=[$LAB_AGENT_ROL]"']).out).toContain("ROL=[]");
  });

  test("Z5: zonder bun faalt de wrapper luid bij PreToolUse (exit 2, geen commando) en is hij stil bij andere events", () => {
    schrijfIdentiteit(staat, werk, ident);
    const env = { PATH: "/usr/bin:/bin", HOME: dir, LAB_LEAD_STAAT: staat, LAB_LEAD_BUN: join(dir, "weg") };
    const pre = draai(env, { cwd: werk, hook_event_name: "PreToolUse" }, ['echo "GELOPEN"']);
    expect(pre.code).toBe(2);
    expect(pre.out).not.toContain("GELOPEN");
    expect(pre.err).toContain("bun niet gevonden");
    const stop = draai(env, { cwd: werk, hook_event_name: "Stop" }, ['echo "GELOPEN"']);
    expect(stop.code).toBe(0);
    expect(stop.out).not.toContain("GELOPEN");
  });
});

describe("b) een ontbrekend of niet-uitvoerbaar commando", () => {
  test("PreToolUse: exit 2 met uitleg (Codex leest exit 1 als niet-blokkerend, dus fail-open); andere events exit 1", () => {
    for (const cmd of [join(dir, "bestaat-niet.sh"), join(dir, "niet-uitvoerbaar.sh")]) {
      writeFileSync(join(dir, "niet-uitvoerbaar.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const env = { ...hookEnv({ LAB_LEAD_STAAT: staat }) };
      const run = (event: string) => {
        const p = Bun.spawnSync(["/bin/sh", WRAP, cmd], { env, stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: event, cwd: werk })), stdout: "pipe", stderr: "pipe" });
        return { code: p.exitCode, err: p.stderr.toString() };
      };
      const pre = run("PreToolUse");
      expect(pre.code).toBe(2);
      expect(pre.err).toContain("kon");
      expect(pre.err).toContain("codex-installeer");
      expect(run("Stop").code).toBe(1);
    }
  });
});

describe("M1: de rol uit het identiteitsbestand komt aan bij grenzen.sh", () => {
  const BASIS = () => join(dir, "repos");
  function git(cwd: string, ...args: string[]) {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...schoneEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  }
  test("een Codex-hook zonder LAB_AGENT_ROL in zijn eigen omgeving krijgt de rol uit de identiteit: git fetch in de hoofdcheckout wordt geweigerd; zonder identiteit niet", () => {
    const hoofd = join(BASIS(), "hoofd");
    const wt = join(BASIS(), "eigen-worktree");
    mkdirSync(hoofd, { recursive: true });
    git(hoofd, "init", "-q", "-b", "main");
    writeFileSync(join(hoofd, "a"), "a");
    git(hoofd, "add", ".");
    git(hoofd, "commit", "-q", "-m", "init");
    git(hoofd, "worktree", "add", "-q", "-b", "eigen", wt);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-wrap-test", LAB_LEAD_BUN: process.execPath, LAB_LEAD_STAAT: staat, LAB_HOOFDCHECKOUT: realpathSync(hoofd), LAB_GRENS_MERGE: "" };
    const aanroep = (cwd: string) => {
      const invoer = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `git -C ${hoofd} fetch` }, cwd };
      const p = Bun.spawnSync(["/bin/sh", WRAP, "/bin/bash", GRENZEN], { env, stdin: new TextEncoder().encode(JSON.stringify(invoer)), stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, err: p.stderr.toString() };
    };
    expect(aanroep(wt).code).toBe(0); // nog geen identiteit: geen rol, de rolregels gelden niet
    schrijfIdentiteit(staat, wt, ident);
    const met = aanroep(wt);
    expect(met.code).toBe(2);
    expect(met.err).toContain("schrijft in de gedeelde hoofdcheckout");
    // een andere checkout heeft de identiteit niet
    expect(aanroep(join(dir, "ergens-anders")).code).toBe(0);
  });
});
