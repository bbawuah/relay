import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdUitInvoer, identiteitEnv } from "./codex-wrap";
import { IDENTITEIT_MAX_MS, identiteitPad, leesIdentiteit, schrijfIdentiteit, wisIdentiteit } from "./register";

const WRAP = join(import.meta.dir, "codex-wrap.sh");
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
const schoneEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: "/usr/bin:/bin", HOME: dir, LAB_LEAD_BUN: process.execPath, ...extra });

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
    const r = draai(schoneEnv({ LAB_LEAD_STAAT: staat }), invoer);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ROL=agent NAAM=cx1 LEAD=lead-x T3=mcp:abc");
    expect(r.out).toContain(JSON.stringify(invoer));
  });

  test("de identiteit uit het bestand wint van een verouderde daemon-omgeving (Codex-TUI: hooks erven de omgeving van de daemon)", () => {
    schrijfIdentiteit(staat, werk, { naam: "cx1", rol: "agent", lead: "lead-x", opdracht: "/o/OPDRACHT.md", spawn_id: "sp-1", ts: Date.now() });
    const r = draai(schoneEnv({ LAB_LEAD_STAAT: staat, LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: "andere-sessie", LAB_LEAD_NAAM: "l", LAB_T3_THREAD: "oud" }), { cwd: werk });
    expect(r.out).toContain("ROL=agent NAAM=cx1 LEAD=lead-x T3=\n");
  });

  test("zonder identiteit voor deze checkout blijft de omgeving zoals hij was (codex exec, geen daemon)", () => {
    schrijfIdentiteit(staat, werk, ident);
    const r = draai(schoneEnv({ LAB_LEAD_STAAT: staat, LAB_AGENT_ROL: "sublead", LAB_AGENT_NAAM: "eigen", LAB_LEAD_NAAM: "l" }), { cwd: join(dir, "andere") });
    expect(r.out).toContain("ROL=sublead NAAM=eigen LEAD=l T3=");
  });

  test("zonder identiteit draait het commando ongewijzigd (grenzen.sh moet ook zonder rol werken); exit 2 en stderr gaan door", () => {
    const r = draai(schoneEnv({ LAB_LEAD_STAAT: staat }), { cwd: werk }, ['echo "ROL=[$LAB_AGENT_ROL]"; echo geweigerd >&2; exit 2']);
    expect(r.code).toBe(2);
    expect(r.out).toContain("ROL=[]");
    expect(r.err).toContain("geweigerd");
    mkdirSync(join(staat, "identiteit"), { recursive: true });
    expect(draai(schoneEnv({ LAB_LEAD_STAAT: staat }), { cwd: werk }, ['echo "ROL=[$LAB_AGENT_ROL]"']).out).toContain("ROL=[]");
  });

  test("zonder bun draait het commando toch (faalt open)", () => {
    schrijfIdentiteit(staat, werk, ident);
    const r = draai({ PATH: "/usr/bin:/bin", HOME: dir, LAB_LEAD_STAAT: staat, LAB_LEAD_BUN: join(dir, "weg") }, { cwd: werk }, ['echo "ROL=[$LAB_AGENT_ROL]"']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ROL=[]");
  });
});
