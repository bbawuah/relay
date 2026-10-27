import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS, MERK, type Opties, installeer, kiesBun, leesArgs } from "./installeer-hooks";

// Alles in een wegwerpmap; de echte ~/.claude wordt nooit gelezen of geschreven.

let dir: string;
let settings: string;
let doel: string;
const NU = new Date("2026-10-07T10:11:12.345Z");

// De vorm van de bestaande hooks (tmux-pwa status.sh, grenzen.sh, werknotities.sh) en een
// top-level sleutel naast hooks.
const ORIGINEEL = () => ({
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    SessionEnd: [{ hooks: [{ type: "command", command: "~/.claude/tmux/status.sh SessionEnd" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "~/.claude/tmux/status.sh UserPromptSubmit" }] }],
    PreToolUse: [
      { matcher: "*", hooks: [{ type: "command", command: "~/.claude/tmux/status.sh PreToolUse" }] },
      { matcher: "Bash|Read|Grep|Glob|NotebookRead", hooks: [{ type: "command", command: "~/.claude/hooks/grenzen.sh", timeout: 10 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "~/.claude/tmux/status.sh Stop" }] }],
    Notification: [{ matcher: "permission_prompt|idle_prompt", hooks: [{ type: "command", command: "~/.claude/tmux/status.sh Notification" }] }],
    PreCompact: [{ hooks: [{ type: "command", command: "~/.claude/hooks/werknotities.sh" }] }],
    SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: "~/.claude/hooks/werknotities.sh" }] }],
  },
});

const schrijf = (j: unknown) => writeFileSync(settings, `${JSON.stringify(j, null, 2)}\n`);
const lees = () => JSON.parse(readFileSync(settings, "utf8"));
const opties = (extra: Partial<Opties> = {}): Opties => ({
  droog: false,
  verwijder: false,
  metWekker: false,
  settings,
  doel,
  bun: "/opt/bun/bin/bun",
  nu: NU,
  bron: join(import.meta.dir, "hooks"),
  ...extra,
});
const eigenCmds = (hooks: Record<string, any[]>) =>
  Object.entries(hooks).flatMap(([ev, gs]) => gs.flatMap((g) => (g.hooks ?? []).filter((h: any) => h.command.includes(MERK)).map((h: any) => ({ ev, matcher: g.matcher, ...h }))));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installeer-hooks-"));
  settings = join(dir, "claude", "settings.json");
  doel = join(dir, "claude", "hooks", "lab-lead-hooks");
  Bun.spawnSync(["mkdir", "-p", join(dir, "claude")]);
  schrijf(ORIGINEEL());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("installeer-hooks", () => {
  test("voegt per event een eigen entry toe en laat de rest ongemoeid", () => {
    const r = installeer(opties());
    expect(r.code).toBe(0);
    const nu = lees();
    const oud = ORIGINEEL();
    expect(nu.model).toBe("opus");
    expect(nu.permissions).toEqual(oud.permissions);
    // bestaande entries blijven gelijk, in dezelfde volgorde, vóór de eigen entry
    for (const [ev, gs] of Object.entries(oud.hooks)) expect(nu.hooks[ev].slice(0, gs.length)).toEqual(gs);
    const eigen = eigenCmds(nu.hooks);
    expect(eigen.map((e) => e.ev).sort()).toEqual(EVENTS.map((e) => e.event).sort());
    for (const e of eigen) {
      expect(e.command).toBe(`LAB_LEAD_BUN=/opt/bun/bin/bun ${doel}/hook.sh`);
      expect(e.timeout).toBe(e.ev === "SessionEnd" ? 1 : 5);
    }
    expect(eigen.find((e) => e.ev === "PreToolUse")?.matcher).toBe("*");
    expect(eigen.find((e) => e.ev === "PostToolUse")?.matcher).toBe("SendMessage|WebFetch|WebSearch|mcp__.*");
    expect(nu.hooks.PreCompact).toEqual(oud.hooks.PreCompact);
  });

  test("kopieert hook.sh (uitvoerbaar), hook.ts, register.ts en codex-adapter.ts", () => {
    installeer(opties());
    expect(readdirSync(doel).sort()).toEqual(["codex-adapter.ts", "hook.sh", "hook.ts", "register.ts"]);
    expect(statSync(join(doel, "hook.sh")).mode & 0o111).toBeGreaterThan(0);
  });

  test("twee keer installeren geeft hetzelfde resultaat en schrijft de tweede keer niets", () => {
    installeer(opties());
    const eerste = readFileSync(settings, "utf8");
    const backups = readdirSync(join(dir, "claude")).filter((f) => f.includes("voor-lead-hooks")).length;
    const r = installeer(opties({ nu: new Date("2026-10-07T11:00:00.000Z") }));
    expect(r.code).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(eerste);
    expect(readdirSync(join(dir, "claude")).filter((f) => f.includes("voor-lead-hooks")).length).toBe(backups);
    expect(eigenCmds(lees().hooks).length).toBe(EVENTS.length);
  });

  test("een eigen entry met een ander bun-pad wordt op zijn plaats vervangen, niet erbij gezet", () => {
    installeer(opties());
    installeer(opties({ bun: "/nieuw/bun" }));
    const eigen = eigenCmds(lees().hooks);
    expect(eigen.length).toBe(EVENTS.length);
    expect(eigen.every((e) => e.command.startsWith("LAB_LEAD_BUN=/nieuw/bun "))).toBe(true);
    // PreToolUse: de eigen entry staat nog na de twee bestaande, niet erdoorheen
    expect(lees().hooks.PreToolUse.length).toBe(3);
  });

  test("--verwijder herstelt het origineel", () => {
    installeer(opties());
    const r = installeer(opties({ verwijder: true }));
    expect(r.code).toBe(0);
    expect(lees()).toEqual(ORIGINEEL());
    expect(readFileSync(settings, "utf8")).toBe(`${JSON.stringify(ORIGINEEL(), null, 2)}\n`);
  });

  test("--verwijder zonder eigen entries wijzigt niets", () => {
    const voor = readFileSync(settings, "utf8");
    const r = installeer(opties({ verwijder: true }));
    expect(r.code).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(voor);
  });

  test("--droog schrijft niets (geen settings, geen backup, geen kopie) en toont diff en bestanden", () => {
    const voor = readFileSync(settings, "utf8");
    const r = installeer(opties({ droog: true }));
    expect(r.code).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(voor);
    expect(readdirSync(join(dir, "claude"))).toEqual(["settings.json"]);
    expect(existsSync(doel)).toBe(false);
    expect(r.stdout).toContain("hook.ts");
    expect(r.stdout).toContain("+ ");
    expect(r.stdout).toContain(`${doel}/hook.sh`);
    expect(r.stdout).toContain("niets geschreven");
  });

  test("maakt een backup met de originele inhoud voor het schrijven", () => {
    const voor = readFileSync(settings, "utf8");
    installeer(opties());
    const backup = join(dir, "claude", "settings.json.voor-lead-hooks-20261007-101112345");
    expect(readFileSync(backup, "utf8")).toBe(voor);
  });

  test("--met-wekker voegt een Stop-entry met asyncRewake en lange timeout toe; zonder de vlag verdwijnt hij weer", () => {
    installeer(opties({ metWekker: true }));
    const wekker = eigenCmds(lees().hooks).filter((e) => e.command.endsWith(" wekker"));
    expect(wekker.length).toBe(1);
    expect(wekker[0].ev).toBe("Stop");
    expect(wekker[0].asyncRewake).toBe(true);
    expect(wekker[0].timeout).toBeGreaterThan(1800);
    installeer(opties());
    expect(eigenCmds(lees().hooks).some((e) => e.command.endsWith(" wekker"))).toBe(false);
    installeer(opties({ verwijder: true }));
    expect(lees()).toEqual(ORIGINEEL());
  });

  test("een pad met spatie in bun of doel wordt veilig gequote", () => {
    const spatie = join(dir, "met spatie", "lab-lead-hooks");
    installeer(opties({ doel: spatie, bun: "/pad met spatie/bun" }));
    const c = eigenCmds(lees().hooks)[0].command as string;
    expect(c).toBe(`LAB_LEAD_BUN='/pad met spatie/bun' '${spatie}/hook.sh'`);
    installeer(opties({ doel: spatie, verwijder: true }));
    expect(lees()).toEqual(ORIGINEEL());
  });

  test("zonder settings.json: maakt hem aan, --verwijder doet dan niets", () => {
    rmSync(settings);
    expect(installeer(opties({ verwijder: true })).code).toBe(0);
    expect(existsSync(settings)).toBe(false);
    expect(installeer(opties()).code).toBe(0);
    expect(Object.keys(lees())).toEqual(["hooks"]);
    expect(installeer(opties({ verwijder: true })).code).toBe(0);
    expect(lees()).toEqual({});
  });

  test("ongeldige JSON of een vreemde vorm: weigert en laat het bestand staan", () => {
    writeFileSync(settings, "{ kapot");
    const r = installeer(opties());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/geen geldige JSON/);
    expect(readFileSync(settings, "utf8")).toBe("{ kapot");
    schrijf({ hooks: [] });
    expect(installeer(opties()).code).toBe(1);
    schrijf({ hooks: { Stop: "nee" } });
    expect(installeer(opties()).code).toBe(1);
    expect(existsSync(doel)).toBe(false);
  });

  test("weigert een doel dat niet op lab-lead-hooks eindigt", () => {
    const r = installeer(opties({ doel: join(dir, "ergens") }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/lab-lead-hooks/);
  });

  test("een groep met een eigen en een vreemde hook: alleen de eigen gaat weg", () => {
    const j = ORIGINEEL();
    j.hooks.Stop = [{ hooks: [{ type: "command", command: "x.sh" }, { type: "command", command: `/h/${MERK}` }] }] as never;
    schrijf(j);
    installeer(opties({ verwijder: true }));
    expect(lees().hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "x.sh" }] }]);
  });

  test("modus van settings.json blijft behouden: 600 blijft 600 (ook na --verwijder), 644 blijft 644", () => {
    const modus = () => statSync(settings).mode & 0o777;
    chmodSync(settings, 0o600);
    installeer(opties());
    expect(modus()).toBe(0o600);
    installeer(opties({ verwijder: true }));
    expect(modus()).toBe(0o600);
    expect(lees()).toEqual(ORIGINEEL());
    chmodSync(settings, 0o644);
    installeer(opties());
    expect(modus()).toBe(0o644);
    installeer(opties({ verwijder: true }));
    expect(modus()).toBe(0o644);
    const backups = readdirSync(join(dir, "claude")).filter((f) => f.includes("voor-lead-hooks"));
    expect(backups.length).toBeGreaterThan(0);
    for (const b of backups) expect(statSync(join(dir, "claude", b)).mode & 0o777).toBeOneOf([0o600, 0o644]);
  });

  test("een backup krijgt de modus van het bestand", () => {
    chmodSync(settings, 0o644);
    installeer(opties());
    const backup = join(dir, "claude", "settings.json.voor-lead-hooks-20261007-101112345");
    expect(statSync(backup).mode & 0o777).toBe(0o644);
  });

  test("een nieuw settings.json krijgt modus 600", () => {
    rmSync(settings);
    installeer(opties());
    expect(statSync(settings).mode & 0o777).toBe(0o600);
  });

  test("een symlink blijft een symlink: het doel wordt herschreven en houdt zijn modus", () => {
    const dot = join(dir, "dotfiles");
    mkdirSync(dot);
    const echt = join(dot, "settings.json");
    renameSync(settings, echt);
    chmodSync(echt, 0o600);
    symlinkSync(echt, settings);
    const r = installeer(opties());
    expect(r.code).toBe(0);
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(readlinkSync(settings)).toBe(echt);
    expect(eigenCmds(JSON.parse(readFileSync(echt, "utf8")).hooks).length).toBe(EVENTS.length);
    expect(statSync(echt).mode & 0o777).toBe(0o600);
    // backup en tmp horen naast het doel, niet naast de link
    expect(readdirSync(dot).some((f) => f.includes("voor-lead-hooks"))).toBe(true);
    expect(readdirSync(join(dir, "claude")).filter((f) => f.includes("voor-lead-hooks"))).toEqual([]);
  });

  test("na een geslaagde run staat er geen tmp-bestand meer in de map", () => {
    installeer(opties());
    installeer(opties({ verwijder: true }));
    expect(readdirSync(join(dir, "claude")).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  test("leesArgs: standaardpaden onder HOME, opties en fouten", () => {
    const a = leesArgs([], "/h");
    expect(a).toMatchObject({ settings: "/h/.claude/settings.json", doel: "/h/.claude/hooks/lab-lead-hooks", droog: false });
    expect(leesArgs(["--droog", "--met-wekker", "--settings", "/x/s.json"], "/h")).toMatchObject({ droog: true, metWekker: true, settings: "/x/s.json" });
    expect(leesArgs(["--settings"], "/h")).toMatch(/waarde/);
    expect(leesArgs(["--nee"], "/h")).toMatch(/onbekend/);
    expect(leesArgs(["--verwijder", "--met-wekker"], "/h")).toMatch(/sluiten elkaar uit/);
  });
});

describe("kiesBun", () => {
  test("bun uit PATH wint van het versiepad van het proces", () => {
    expect(kiesBun(() => "/opt/homebrew/bin/bun", "/opt/homebrew/Cellar/bun/1.4.2/bin/bun")).toBe("/opt/homebrew/bin/bun");
  });
  test("niets in PATH: terugval op process.execPath", () => {
    expect(kiesBun(() => null, "/opt/homebrew/Cellar/bun/1.4.2/bin/bun")).toBe("/opt/homebrew/Cellar/bun/1.4.2/bin/bun");
  });
  test("een relatief pad uit PATH telt niet", () => {
    expect(kiesBun(() => "bun", "/x/bun")).toBe("/x/bun");
  });
  test("standaard gebruikt hij Bun.which en geeft een absoluut pad", () => {
    expect(kiesBun().startsWith("/")).toBe(true);
  });
});
