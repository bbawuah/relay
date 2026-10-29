import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Opties, installeer } from "../installeer-hooks";
import { installeer as installeerOud } from "./fixtures/installeer-hooks-oud";
import { beleid } from "./beleid";
import { MERK, genereer } from "./claude";
import { hosts } from "./hosts";

// Alles in een wegwerpmap; de echte ~/.claude wordt nooit gelezen of geschreven.
let dir: string;
let settings: string;
let doel: string;
const NU = new Date("2026-10-07T10:11:12.345Z");
const BRON = join(import.meta.dir, "..", "hooks");

test("upgrade en verwijderen pensioneren exact de oude eigen grenzenmarker en bewaren native hooks", () => {
  for (const verwijder of [false, true]) {
    const native = { type: "command", command: "/native/security-hook" };
    const andereMarker = { type: "command", command: "LAB_BELEID_ID=grenzen-extra /native/ander.sh" };
    const oudeGrens = { type: "command", command: "LAB_BELEID_ID=grenzen /legacy/grenzen.sh" };
    const oud = { permissions: { deny: ["native-rule"] }, hooks: { PreToolUse: [{ matcher: ".*", hooks: [native, oudeGrens, andereMarker] }] } };
    writeFileSync(settings, JSON.stringify(oud));
    const r = installeer({ droog: false, verwijder, metWekker: false, settings, doel, bun: process.execPath, nu: NU, bron: BRON });
    expect(r.code).toBe(0);
    const nieuw = JSON.parse(readFileSync(settings, "utf8"));
    const commands = nieuw.hooks.PreToolUse.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(commands).toContain(native.command);
    expect(commands).toContain(andereMarker.command);
    expect(commands).not.toContain(oudeGrens.command);
    expect(nieuw.permissions).toEqual(oud.permissions);
  }
});

// De structuur van Brians settings.json met nep-waarden: eigen sleutels, tmux-pwa, werknotities en grenzen.sh.
const BRIAN = () => ({
  autoMode: { allow: ["nep regel"], soft_deny: ["nep"] },
  model: "nep-model",
  theme: "nep-thema",
  statusLine: { type: "command", command: "nep-statusline" },
  env: { NEP_VARIABELE: "nep-waarde" },
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    SessionEnd: [
      { hooks: [{ type: "command", command: "~/.claude/tmux/pane-info-clear.sh" }] },
      { hooks: [{ type: "command", command: "/nep/tmux-pwa/hooks/status.sh", timeout: 5 }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "/nep/tmux-pwa/hooks/status.sh", timeout: 5 }] }],
    PreToolUse: [
      { matcher: "*", hooks: [{ type: "command", command: "/nep/tmux-pwa/hooks/status.sh", timeout: 5 }] },
      { matcher: "Bash|Read|Grep|Glob|NotebookRead", hooks: [{ type: "command", command: "/nep/home/.claude/hooks/grenzen.sh", timeout: 5 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "/nep/tmux-pwa/hooks/status.sh", timeout: 5 }] }],
    PreCompact: [{ hooks: [{ type: "command", command: "~/.claude/hooks/werknotities.sh" }] }],
    SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: "~/.claude/hooks/werknotities.sh" }] }],
  },
});

// Snapshot uit een fixturebestand; opnieuw maken met BELEID_FIXTURES=1 (en dan de diff nalopen).
function snapshot(naam: string, waarde: unknown) {
  const pad = join(import.meta.dir, "fixtures", naam);
  if (process.env.BELEID_FIXTURES === "1") writeFileSync(pad, `${JSON.stringify(waarde, null, 2)}\n`);
  expect(waarde).toEqual(JSON.parse(readFileSync(pad, "utf8")));
}

const schrijf = (j: unknown) => writeFileSync(settings, `${JSON.stringify(j, null, 2)}\n`);
const lees = () => JSON.parse(readFileSync(settings, "utf8"));
const opties = (extra: Partial<Opties> = {}): Opties => ({ droog: false, verwijder: false, metWekker: false, settings, doel, bun: "/opt/bun/bin/bun", nu: NU, bron: BRON, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beleid-"));
  settings = join(dir, "claude", "settings.json");
  doel = join(dir, "claude", "hooks", "lab-lead-hooks");
  mkdirSync(join(dir, "claude"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Alles wat een run achterlaat: uitkomst, settings.json en de rest van de map (backups, gekopieerde hookbestanden). */
function momentopname(f: (o: Opties) => ReturnType<typeof installeer>, o: Opties, begin: unknown) {
  rmSync(join(dir, "claude"), { recursive: true, force: true });
  mkdirSync(join(dir, "claude"), { recursive: true });
  if (begin !== undefined) schrijf(begin);
  const u = f(o);
  const bestanden: Record<string, string> = {};
  const loop = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const pad = join(p, e.name);
      if (e.isDirectory()) loop(pad);
      else bestanden[pad.slice(dir.length)] = readFileSync(pad, "utf8");
    }
  };
  loop(join(dir, "claude"));
  return { u, bestanden };
}

describe("beleidslaag fase 1: geen gedragsverandering", () => {
  const GEVALLEN: [string, Partial<Opties>, () => unknown][] = [
    ["installeren in Brians settings", {}, BRIAN],
    ["installeren zonder settings.json", {}, () => undefined],
    ["installeren in een lege settings", {}, () => ({})],
    ["met wekker", { metWekker: true }, BRIAN],
    ["droog", { droog: true }, BRIAN],
    ["droog met wekker", { droog: true, metWekker: true }, BRIAN],
    ["verwijderen", { verwijder: true }, BRIAN],
    ["verwijderen zonder settings.json", { verwijder: true }, () => undefined],
    ["een ander bun-pad met spatie", { bun: "/pad met spatie/bun" }, BRIAN],
  ];
  for (const [naam, extra, begin] of GEVALLEN) {
    test(`byte-gelijk met installeer-hooks.ts van main: ${naam}`, () => {
      const o = opties(extra);
      const oud = momentopname(installeerOud, o, begin());
      const nieuw = momentopname(installeer, o, begin());
      expect(nieuw.u).toEqual(oud.u);
      expect(nieuw.bestanden).toEqual(oud.bestanden);
    });
  }
  test("byte-gelijk bij een installatie die er al staat (tweede run en na verwijderen)", () => {
    const o = opties({ metWekker: true });
    for (const stap of [o, opties(), opties({ verwijder: true })]) {
      const oud = momentopname(installeerOud, stap, undefined);
      const nieuw = momentopname(installeer, stap, undefined);
      expect(nieuw.bestanden).toEqual(oud.bestanden);
    }
    // beide in dezelfde map achter elkaar: de tweede run vindt wat de eerste schreef
    rmSync(join(dir, "claude"), { recursive: true, force: true });
    mkdirSync(join(dir, "claude"), { recursive: true });
    schrijf(BRIAN());
    installeerOud(o);
    const eerste = readFileSync(settings, "utf8");
    const nieuw = installeer(o);
    expect(readFileSync(settings, "utf8")).toBe(eerste);
    expect(nieuw.stdout).toContain("settings.json was al in orde, niet herschreven");
  });
  test("een kapotte settings.json geeft dezelfde fout", () => {
    for (const inhoud of ["{ geen json", "[]", JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { Stop: {} } })]) {
      const doe = (f: typeof installeer) => {
        rmSync(join(dir, "claude"), { recursive: true, force: true });
        mkdirSync(join(dir, "claude"), { recursive: true });
        writeFileSync(settings, inhoud);
        return f(opties());
      };
      expect(doe(installeer)).toEqual(doe(installeerOud));
    }
  });
});

describe("beleidslaag fase 1: eigen entries en de rest", () => {
  test("alles zonder markering blijft onaangeroerd (autoMode, model, theme, statusLine, env, andere hooks)", () => {
    schrijf(BRIAN());
    expect(installeer(opties({ metWekker: true })).code).toBe(0);
    const na = lees();
    const voor = BRIAN();
    for (const k of ["autoMode", "model", "theme", "statusLine", "env", "permissions"] as const) expect(na[k]).toEqual(voor[k]);
    // elke hook-entry van Brian staat er nog, in dezelfde volgorde
    const vreemd = (hooks: Record<string, any[]>) =>
      Object.fromEntries(Object.entries(hooks).map(([ev, gs]) => [ev, gs.filter((g) => !JSON.stringify(g).includes(MERK))]));
    const verwacht = voor.hooks as Record<string, any[]>;
    const gevonden = vreemd(na.hooks);
    for (const ev of Object.keys(verwacht)) expect(gevonden[ev]).toEqual(verwacht[ev]);
    // en verwijderen brengt precies het begin terug
    expect(installeer(opties({ verwijder: true })).code).toBe(0);
    expect(lees()).toEqual(voor);
  });
  test("de grenzen-entry van Brian blijft ongemoeid en komt niet dubbel (fase 1 zet hem niet)", () => {
    schrijf(BRIAN());
    installeer(opties());
    const pre = lees().hooks.PreToolUse as any[];
    expect(pre.filter((g) => JSON.stringify(g).includes("grenzen.sh"))).toHaveLength(1);
    expect(JSON.stringify(lees())).not.toContain("LAB_BELEID_ID=");
  });
  test("een installatie van vóór de beleidslaag wordt als eigen herkend: vervangen, niet verdubbeld", () => {
    schrijf(BRIAN());
    installeerOud(opties());
    const eenmaal = readFileSync(settings, "utf8");
    installeer(opties());
    expect(readFileSync(settings, "utf8")).toBe(eenmaal);
    const aantal = (JSON.stringify(lees()).match(/lab-lead-hooks\/hook\.sh/g) ?? []).length;
    expect(aantal).toBe(10);
  });
});

describe("beleidslaag fase 1: de generator", () => {
  const o = { doel: "/nep/home/.claude/hooks/lab-lead-hooks", bun: "/opt/bun/bin/bun", metWekker: false, verwijder: false, settings: "/nep/home/.claude/settings.json" };
  const hooksVan = (r: ReturnType<typeof genereer>) => JSON.parse(r.bestanden[0]!.inhoud).hooks;

  test("snapshot: lead-hooks op een lege settings", () => {
    snapshot("claude-leeg.json", genereer(beleid, "claude", o));
  });

  test("deterministisch en pure invoer: dezelfde uitvoer, de invoer is niet gewijzigd", () => {
    const b = BRIAN();
    const a1 = genereer(beleid, "claude", { ...o, bestaand: b });
    const a2 = genereer(beleid, "claude", { ...o, bestaand: b });
    expect(a1).toEqual(a2);
    expect(b).toEqual(BRIAN());
  });

  test("alsBestaat: ontbreekt het pad, dan wordt de hook overgeslagen met een melding", () => {
    const b = { ...beleid, hooks: beleid.hooks.map((h) => (h.id === "lead-sessie-start" ? { ...h, alsBestaat: "/nep/bestaat-niet" } : h)) };
    const r = genereer(b, "claude", { ...o, bestaat: () => false });
    expect(r.waarschuwingen.join("\n")).toContain("/nep/bestaat-niet bestaat niet");
    expect(hooksVan(r).SessionStart).toBeUndefined();
  });
  test("niet vertaalbaar: een melding in plaats van stil weglaten", () => {
    const b = { ...beleid, hooks: [{ id: "x", event: "toestemming" as const, script: "lead-hook" as const, timeoutS: 5, hosts: ["claude" as const] }, { id: "y", event: "voor-tool" as const, tools: ["shell" as const], script: "werknotities-pre" as const, timeoutS: 5 }] };
    const r = genereer(b, "claude", o);
    expect(r.waarschuwingen.join("\n")).toContain("werknotities-pre");
    expect(r.waarschuwingen.join("\n")).toContain("autoMode");
    expect(genereer(beleid, "codex", o).bestanden).toEqual([]);
  });
  test("elk neutraal event heeft een vertaling of expliciet null in de Claude-kolom; Codex-kolom nog leeg", () => {
    expect(hosts.codex).toBeNull();
    expect(Object.values(hosts.claude!.events).every((v) => v === null || typeof v === "string")).toBe(true);
  });
});

describe("beleid.ts: geen geheimen", () => {
  // Sleutelvormen: dezelfde als scripts/mollie-sleutels.ts plus de gangbare tokenvormen.
  const SLEUTELVORM = [
    /(?:live_[A-Za-z0-9]{20,}|test_[A-Za-z0-9]{25,}|access_[A-Za-z0-9]{20,}|refresh_[A-Za-z0-9]{20,})/,
    /(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{15,}\.)/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /[A-Za-z0-9+/_-]{32,}={0,2}/,
  ];
  const waarden = () => [...Object.values(beleid.env), ...beleid.mcp.flatMap((m) => Object.values(m.env ?? {}))];
  test("env en mcp[].env bevatten geen sleutelvormen", () => {
    for (const w of waarden()) for (const re of SLEUTELVORM) expect(re.test(w)).toBe(false);
  });
  test("de controle vangt een sleutelvorm (kanarie)", () => {
    const nep = ["live_" + "a1".repeat(12), "ghp_" + "Ab1".repeat(10), "x".repeat(40)];
    for (const w of nep) expect(SLEUTELVORM.some((re) => re.test(w))).toBe(true);
  });
  test("de bronbestanden bevatten zelf geen sleutelvorm", () => {
    for (const f of ["beleid.ts", "hosts.ts", "typen.ts", "claude.ts", "codex-werker.ts"]) {
      const t = readFileSync(join(import.meta.dir, f), "utf8");
      for (const re of SLEUTELVORM.slice(0, 3)) expect(re.test(t)).toBe(false);
    }
  });
  test("ids zijn uniek", () => {
    const ids = beleid.hooks.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
