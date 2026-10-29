import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kiesBun } from "../installeer-hooks";
import { PEERS_BESTANDEN } from "./peers-kopie";
import { BESTANDEN, EINDE, EVENTS, START, blokIn, commando, installeer, leesArgs, maakBlok, zetBlok, type Opties } from "./codex-installeer";

const BRON = import.meta.dir;
let dir: string;
let home: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-installeer-"));
  home = join(dir, "codexhome");
  mkdirSync(home, { mode: 0o700 });
  cfg = join(home, "config.toml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const opties = (extra: Partial<Opties> = {}): Opties => ({ droog: false, verwijder: false, codexHome: home, doel: join(home, "hooks", "lab-lead-hooks"), bun: process.execPath, codex: "codex", bron: BRON, ...extra });

test("optionele installatie bewaart configuratie, modus en backup zonder native trust te schrijven", async () => {
  const oorspronkelijk = 'model = "eigen-model"\n';
  writeFileSync(cfg, oorspronkelijk, { mode: 0o640 });
  expect((await installeer(opties())).code).toBe(0);
  expect(readFileSync(`${cfg}.voor-peerbus`, "utf8")).toBe(oorspronkelijk);
  expect(statSync(cfg).mode & 0o777).toBe(0o640);
  const een = readFileSync(cfg, "utf8");
  expect(een).toContain(oorspronkelijk);
  expect(een).not.toContain("grenzen.sh");
  expect(een).not.toContain("trusted_hash");
  for (const b of BESTANDEN) expect(existsSync(join(opties().doel, b))).toBe(true);
  for (const b of PEERS_BESTANDEN) expect(existsSync(join(opties().doel, "peers", b))).toBe(true);
  expect((await installeer(opties())).code).toBe(0);
  expect(readFileSync(cfg, "utf8")).toBe(een);
  expect(readFileSync(`${cfg}.voor-peerbus`, "utf8")).toBe(oorspronkelijk);
});

test("upgrade vervangt het oude eigen governanceblok en de kopieën, bewaart native security en raakt heldpost niet aan", async () => {
  const o = opties({ codex: join(dir, "codex-mag-niet-draaien") });
  const native = 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "native-security-hook"\n';
  const trust = '\n[hooks.state."native-key"]\ntrusted_hash = "native-ongewijzigd"\n';
  const oud = `${native}\n${START}\n[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "${o.doel}/grenzen.sh"\n${EINDE}\n${trust}`;
  writeFileSync(cfg, oud);
  mkdirSync(o.doel, { recursive: true });
  writeFileSync(join(o.doel, "hook.ts"), "oude rapport-gate");
  const held = join(dir, "staat/peers/vastgehouden");
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, "peer.jsonl"), "ongewijzigde historische post\n");
  expect((await installeer(o)).code).toBe(0);
  const nieuw = readFileSync(cfg, "utf8");
  expect(nieuw.startsWith(native)).toBe(true);
  expect(nieuw).toContain(trust.trim());
  expect(blokIn(nieuw)).not.toContain("grenzen.sh");
  expect(readFileSync(join(o.doel, "hook.ts"))).toEqual(readFileSync(join(BRON, "hook.ts")));
  expect(readFileSync(join(held, "peer.jsonl"), "utf8")).toBe("ongewijzigde historische post\n");
  expect(readFileSync(`${cfg}.voor-peerbus`, "utf8")).toBe(oud);
  expect((await installeer(o)).code).toBe(0);
  expect(readFileSync(cfg, "utf8")).toBe(nieuw);
});

describe("blok en zetBlok", () => {
  test("het blok heeft alle events, de matchers en het commando met wrapper en --bron codex", () => {
    const b = maakBlok(opties());
    expect(b.startsWith(START)).toBe(true);
    expect(b.endsWith(EINDE)).toBe(true);
    for (const e of EVENTS) expect(b).toContain(`[[hooks.${e.event}]]`);
    expect(b).toContain('matcher = ".*"');
    expect(b).toContain("codex-wrap.sh");
    expect(b).toContain("--bron codex");
    expect(commando("/d/lab-lead-hooks", "/b/bun")).toBe("env LAB_LEAD_BUN=/b/bun /d/lab-lead-hooks/codex-wrap.sh /d/lab-lead-hooks/hook.sh --bron codex");
    expect(commando("/mijn map/lab-lead-hooks", "/b/bun")).toContain("'/mijn map/lab-lead-hooks/codex-wrap.sh'");
  });

  test("toevoegen achteraan, vervangen op zijn plaats, weghalen; de rest van het bestand blijft gelijk", () => {
    const voor = 'model = "x"\n\n[projects."/a"]\ntrust_level = "trusted"\n';
    const een = zetBlok(voor, "BLOK1");
    expect(een).toBe(`${voor}\nBLOK1\n`.replace("BLOK1", "BLOK1"));
    const na = '\n[andere]\nk = 1\n';
    const midden = `${voor}\n${START}\nOUD\n${EINDE}\n${na}`;
    const twee = zetBlok(midden, `${START}\nNIEUW\n${EINDE}`);
    expect(twee).toContain("NIEUW");
    expect(twee).not.toContain("OUD");
    expect(twee.endsWith("[andere]\nk = 1\n")).toBe(true);
    expect(zetBlok(twee, null)).not.toContain(START);
    expect(zetBlok(voor, null)).toBe(voor);
    expect(blokIn(twee)).toBe(`${START}\nNIEUW\n${EINDE}`);
    expect(blokIn(voor)).toBeNull();
  });

  test("trust-tabellen die Codex tussen de markeringen schreef, blijven bij vervangen en weghalen", () => {
    const tekst = `${START}\nOUD\n\n[hooks.state."/c:stop:0:0"]\ntrusted_hash = "sha256:aa"\n${EINDE}\n`;
    for (const blok of [`${START}\nNIEUW\n${EINDE}`, null]) {
      const u = zetBlok(tekst, blok);
      expect(u).toContain('[hooks.state."/c:stop:0:0"]');
      expect(u).toContain("sha256:aa");
      expect(u).not.toContain("OUD");
    }
  });
});

describe("installeer", () => {
  test("--droog schrijft niets: geen config, geen backup, geen bestanden, geen app-server", async () => {
    writeFileSync(cfg, 'model = "x"\n');
    const u = await installeer(opties({ droog: true }));
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("droog: blok: wordt toegevoegd");
    expect(u.stdout).toContain("droog: er is niets geschreven");
    expect(readFileSync(cfg, "utf8")).toBe('model = "x"\n');
    expect(existsSync(`${cfg}.voor-peerbus`)).toBe(false);
    expect(existsSync(join(home, "hooks"))).toBe(false);
  });

  test("zonder bestaande config.toml: wordt aangemaakt, geen backup", async () => {
    const u = await installeer(opties());
    expect(u.code).toBe(0);
    expect(existsSync(cfg)).toBe(true);
    expect(existsSync(`${cfg}.voor-peerbus`)).toBe(false);
    expect(u.stdout).toContain("geen (er is nog geen config.toml)");
  });

  test("ontbrekende CODEX_HOME of bronbestand: duidelijke fout, niets geschreven", async () => {
    expect((await installeer(opties({ codexHome: join(dir, "weg") }))).stderr).toContain("CODEX_HOME bestaat niet");
    const u = await installeer(opties({ bron: join(dir, "leeg") }));
    expect(u.code).toBe(1);
    expect(u.stderr).toContain("bronbestand ontbreekt");
    expect(existsSync(cfg)).toBe(false);
  });

  test("--verwijder haalt het blok weg en laat de rest en de gekopieerde bestanden staan", async () => {
    writeFileSync(cfg, 'model = "x"\n');
    await installeer(opties());
    const u = await installeer(opties({ verwijder: true }));
    expect(u.code).toBe(0);
    const nu = readFileSync(cfg, "utf8");
    expect(nu).not.toContain(START);
    expect(nu).toContain('model = "x"');
    expect(existsSync(join(home, "hooks/lab-lead-hooks/hook.sh"))).toBe(true);
  });
});

describe("leesArgs", () => {
  test("standaard ~/.codex of $CODEX_HOME; doel moet op lab-lead-hooks eindigen; onbekende optie", () => {
    const a = leesArgs([], { HOME: "/h" }, "/b") as Opties;
    expect(a.codexHome).toBe("/h/.codex");
    expect(a.doel).toBe("/h/.codex/hooks/lab-lead-hooks");
    expect((leesArgs([], { HOME: "/h", CODEX_HOME: "/c" }, "/b") as Opties).codexHome).toBe("/c");
    expect(leesArgs(["--doel", "/x/y"], {}, "/b")).toContain("lab-lead-hooks");
    expect(leesArgs(["--wat"], {}, "/b")).toContain("onbekende optie");
    expect(leesArgs(["--codex-home"], {}, "/b")).toContain("mist een waarde");
    expect((leesArgs(["--droog", "--verwijder"], { HOME: "/h" }, "/b") as Opties).droog).toBe(true);
  });

  test("Z5: het standaard bun-pad is dat van kiesBun (stabiel pad uit PATH), niet het versiepad van het draaiende proces", () => {
    expect((leesArgs([], { HOME: "/h" }, "/b") as Opties).bun).toBe(kiesBun());
    expect(kiesBun(() => "/opt/homebrew/bin/bun", "/Cellar/bun/1.4.2/bin/bun")).toBe("/opt/homebrew/bin/bun");
  });
});
