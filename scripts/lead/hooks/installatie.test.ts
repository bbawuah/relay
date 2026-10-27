import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../../test-integriteit";
import { installeer as installeerClaude } from "../installeer-hooks";
import type { AppServer, HookInfo } from "./codex-appserver";
import { controleerGrenzen } from "./codex-controle";
import { EVENTS, MERK, installeer } from "./codex-installeer";

// Rooktoets op de INSTALLATIE: de geïnstalleerde bestanden moeten laden en draaien vanuit hun eigen (platte) map, niet alleen in de
// repo-indeling (#685: codex-wrap importeerde ../peers/afgeleide-naam, dat geïnstalleerd niet bestond en elke Codex-hook liet falen).
// Alles in een tijdelijke HOME/CODEX_HOME/LAB_LEAD_STAAT; de echte ~/.codex en ~/.claude blijven ongemoeid.

const BRON = import.meta.dir;
const FIX = join(BRON, "codex-fixtures");
const SID = "01a17ebd-76bc-7472-a451-ac8ef9f536d4";
let dir: string;
let home: string;
let staat: string;
let werk: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "installatie-")));
  home = join(dir, "codexhome");
  staat = join(dir, "staat");
  werk = join(dir, "werk");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(werk);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Nep van `codex app-server`: ziet elke eigen hook als vertrouwd. */
const nep = async (): Promise<AppServer> => ({
  async hooks() {
    return EVENTS.map((e, i): HookInfo => ({ key: `k${i}`, eventName: e.event.toLowerCase(), command: `x ${MERK}`, currentHash: "h", trustStatus: "trusted" }));
  },
  async vertrouw() {},
  sluit() {},
});

const invoer = (naam: string, extra: Record<string, unknown> = {}) => ({ ...JSON.parse(readFileSync(join(FIX, naam), "utf8")), session_id: SID, cwd: werk, ...extra });
function draai(argv: string[], stdin: object, env: Record<string, string> = {}) {
  const e = { ...schoneEnv(), HOME: dir, LAB_LEAD_STAAT: staat, LAB_LEAD_BUN: process.execPath, ...env } as Record<string, string>;
  for (const k of ["LAB_AGENT_NAAM", "LAB_AGENT_ROL", "LAB_LEAD_NAAM", "LAB_OPDRACHT", "LAB_SPAWN_ID", "LAB_T3_THREAD"]) if (!(k in env)) delete e[k];
  const p = Bun.spawnSync(argv, { env: e, cwd: werk, stdin: new TextEncoder().encode(JSON.stringify(stdin)), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("geïnstalleerde Codex-hooks", () => {
  const doel = () => join(home, "hooks", "lab-lead-hooks");

  test("codex-installeer: de geïnstalleerde wrapper, hook.sh en grenzen-groep laden en draaien vanuit de installatiemap", async () => {
    const u = await installeer({ droog: false, verwijder: false, codexHome: home, doel: doel(), bun: process.execPath, codex: "codex", bron: BRON }, { start: nep });
    expect(u.code).toBe(0);
    const wrap = join(doel(), "codex-wrap.sh");
    // wrapper: de afgeleide naam komt uit de geladen peers/afgeleide-naam
    const w = draai(["/bin/sh", wrap, "/bin/sh", "-c", "echo NAAM=$LAB_AGENT_NAAM"], invoer("codex-SessionStart.json"));
    expect(w.err).not.toContain("Cannot find module");
    expect(w.code).toBe(0);
    expect(w.out).toContain("NAAM=codex-ac8ef9f536d4");
    // hook.sh-groep (met rol, anders doet hook.sh niets): registreert de sessie
    const h = draai(["/bin/sh", wrap, "/bin/sh", join(doel(), "hook.sh"), "--bron", "codex"], invoer("codex-SessionStart.json"), { LAB_AGENT_NAAM: "w1", LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "lead" });
    expect(h.err).not.toContain("Cannot find module");
    expect(h.code).toBe(0);
    // grenzen-groep
    const g = draai(["/bin/sh", wrap, "/bin/sh", join(doel(), "grenzen.sh")], invoer("codex-PreToolUse-Bash.json"));
    expect(g.err).not.toContain("Cannot find module");
    expect(g.code).toBe(0);
  });
});

describe("codex-controle: rooktoets", () => {
  test("een geïnstalleerde wrapper die niet laadt (ontbrekend peers-bestand) geeft een reden met de fout; een volledige installatie niet", async () => {
    const doel = join(home, "hooks", "lab-lead-hooks");
    await installeer({ droog: false, verwijder: false, codexHome: home, doel, bun: process.execPath, codex: "codex", bron: BRON }, { start: nep });
    expect(controleerGrenzen(join(home, "config.toml"))).not.toContain("start niet"); // hier alleen: niet vertrouwd (de nep legt niets vast)
    // codex-adapter.ts staat niet in GELIJK_AAN_REPO maar hook.ts importeert het statisch: alleen de rooktoets ziet dit
    rmSync(join(doel, "codex-adapter.ts"));
    expect(controleerGrenzen(join(home, "config.toml"))).toMatch(/geïnstalleerde hook\.ts start niet \(exit 1\): .*codex-adapter/);
  });
});

describe("geïnstalleerde Claude-hooks", () => {
  test("installeer-hooks: de geïnstalleerde hook.ts laadt en registreert de sessie", () => {
    const doel = join(dir, "claudehooks", "lab-lead-hooks");
    const settings = join(dir, "settings.json");
    const u = installeerClaude({ droog: false, verwijder: false, metWekker: false, settings, doel, bun: process.execPath, nu: new Date(), bron: BRON });
    expect(u.code).toBe(0);
    const r = draai(["/bin/sh", join(doel, "hook.sh")], invoer("codex-SessionStart.json"), { LAB_AGENT_NAAM: "w1", LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "lead" });
    expect(r.err).not.toContain("Cannot find module");
    expect(r.code).toBe(0);
    const recs = join(staat, "register");
    expect(existsSync(recs) ? readdirSync(recs).length : 0).toBeGreaterThan(0);
  });
});
