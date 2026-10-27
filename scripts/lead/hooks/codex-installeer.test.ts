import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppServer, HookInfo } from "./codex-appserver";
import { kiesBun } from "../installeer-hooks";
import { PEERS_BESTANDEN } from "./peers-kopie";
import { GELIJK_AAN_REPO, controleerGrenzen, woorden } from "./codex-controle";
import { BESTANDEN, EINDE, EVENTS, GRENZEN_MATCHER, START, blokIn, commando, installeer, leesArgs, maakBlok, zetBlok, type Opties } from "./codex-installeer";

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
const snake = (e: string) => e.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

/** Nep van `codex app-server`: leest de hooks uit config.toml, rekent een hash uit het commando en legt vertrouwen vast als tabel. */
function nepServer(): { start: () => Promise<AppServer>; log: string[] } {
  const log: string[] = [];
  const start = async (): Promise<AppServer> => ({
    async hooks() {
      const tekst = readFileSync(cfg, "utf8");
      const uit: HookInfo[] = [];
      let event = "";
      const groepen: Record<string, number> = {}; // per event het aantal groepen tot nu toe: Codex telt de groep in de sleutel
      let groep = 0;
      for (const regel of tekst.split("\n")) {
        const e = /^\[\[hooks\.([A-Za-z]+)\]\]$/.exec(regel);
        if (e) {
          event = e[1];
          groep = groepen[event] ?? 0;
          groepen[event] = groep + 1;
        }
        const c = /^command = (".*")$/.exec(regel);
        if (c && event) {
          const command = JSON.parse(c[1]) as string;
          const key = `${realpathSync(cfg)}:${snake(event)}:${groep}:0`;
          const currentHash = `sha256:${createHash("sha256").update(`${event}\n${command}`).digest("hex")}`;
          const m = new RegExp(`\\[hooks\\.state\\."${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\ntrusted_hash = "([^"]+)"`).exec(tekst);
          uit.push({ key, eventName: snake(event), command, currentHash, trustStatus: m ? (m[1] === currentHash ? "trusted" : "modified") : "untrusted" });
        }
      }
      return uit;
    },
    async vertrouw(hashes) {
      log.push(`vertrouw ${Object.keys(hashes).length}`);
      let tekst = readFileSync(cfg, "utf8");
      for (const [key, hash] of Object.entries(hashes)) {
        tekst = tekst.replace(new RegExp(`\\n?\\[hooks\\.state\\."${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\ntrusted_hash = "[^"]+"\\n`), "\n");
        tekst += `\n[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`;
      }
      writeFileSync(cfg, tekst);
    },
    sluit() {},
  });
  return { start, log };
}

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

  test("M1: een tweede PreToolUse-groep draait grenzen.sh via de wrapper, met een matcher die Bash en apply_patch dekt", () => {
    const b = maakBlok(opties());
    const groepen = b.split("[[hooks.PostToolUse]]")[0].split("[[hooks.PreToolUse]]").slice(1);
    expect(groepen.length).toBe(2);
    expect(groepen[0]).toContain("hook.sh --bron codex");
    expect(groepen[1]).toContain(`matcher = ${JSON.stringify(GRENZEN_MATCHER)}`);
    expect(groepen[1]).toContain("codex-wrap.sh /");
    expect(groepen[1]).toContain("lab-lead-hooks/grenzen.sh");
    expect(groepen[1]).not.toContain("hook.sh");
    for (const t of ["Bash", "apply_patch"]) expect(new RegExp(GRENZEN_MATCHER).test(t)).toBe(true);
    expect(commando("/d/lab-lead-hooks", "/b/bun", "grenzen.sh")).toBe("env LAB_LEAD_BUN=/b/bun /d/lab-lead-hooks/codex-wrap.sh /d/lab-lead-hooks/grenzen.sh");
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
    const nep = nepServer();
    const u = await installeer(opties({ droog: true }), { start: nep.start });
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("droog: blok: wordt toegevoegd");
    expect(u.stdout).toContain("droog: er is niets geschreven");
    expect(readFileSync(cfg, "utf8")).toBe('model = "x"\n');
    expect(existsSync(`${cfg}.voor-peerbus`)).toBe(false);
    expect(existsSync(join(home, "hooks"))).toBe(false);
    expect(nep.log).toEqual([]);
  });

  test("eerste run: backup van het origineel, blok, bestanden, vertrouwen voor alle hooks; modus van config blijft", async () => {
    writeFileSync(cfg, 'model = "x"\n', { mode: 0o640 });
    const nep = nepServer();
    const u = await installeer(opties(), { start: nep.start });
    expect(u.code).toBe(0);
    expect(u.stderr).toBe("");
    expect(readFileSync(`${cfg}.voor-peerbus`, "utf8")).toBe('model = "x"\n');
    const nu = readFileSync(cfg, "utf8");
    expect(nu.startsWith('model = "x"\n')).toBe(true);
    expect(blokIn(nu)).toBe(maakBlok(opties()));
    expect((nu.match(/trusted_hash/g) ?? []).length).toBe(EVENTS.length);
    expect(statSync(cfg).mode & 0o777).toBe(0o640);
    expect(statSync(`${cfg}.voor-peerbus`).mode & 0o077).toBe(0);
    for (const b of ["hook.sh", "hook.ts", "register.ts", "codex-adapter.ts", "codex-wrap.sh", "codex-wrap.ts", "grenzen.sh"]) {
      expect(BESTANDEN).toContain(b);
      expect(existsSync(join(home, "hooks/lab-lead-hooks", b))).toBe(true);
    }
    expect(statSync(join(home, "hooks/lab-lead-hooks/codex-wrap.sh")).mode & 0o100).toBeTruthy();
    expect(statSync(join(home, "hooks/lab-lead-hooks/grenzen.sh")).mode & 0o100).toBeTruthy();
    // de peerbus voor hook.ts (laadPeers): peers/ en een tweede register.ts onder hooks/
    for (const b of PEERS_BESTANDEN) expect(existsSync(join(home, "hooks/lab-lead-hooks/peers", b))).toBe(true);
    expect(existsSync(join(home, "hooks/lab-lead-hooks/hooks/register.ts"))).toBe(true);
    expect(u.stdout).toContain(`klaar: ${EVENTS.length} hooks vertrouwd`);
  });

  test("tweede run is idempotent: config byte-voor-byte gelijk, backup ongemoeid, niets opnieuw vertrouwd", async () => {
    writeFileSync(cfg, 'model = "x"\n');
    const nep = nepServer();
    await installeer(opties(), { start: nep.start });
    const na1 = readFileSync(cfg, "utf8");
    const backup1 = readFileSync(`${cfg}.voor-peerbus`, "utf8");
    nep.log.length = 0;
    const u = await installeer(opties(), { start: nep.start });
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("blok: ongewijzigd");
    expect(u.stdout).toContain("alle eigen hooks waren al vertrouwd");
    expect(readFileSync(cfg, "utf8")).toBe(na1);
    expect(readFileSync(`${cfg}.voor-peerbus`, "utf8")).toBe(backup1);
    expect(nep.log).toEqual([]);
  });

  test("een ander pad (hook wordt 'modified') wordt opnieuw vertrouwd; de backup blijft het origineel", async () => {
    writeFileSync(cfg, 'model = "x"\n');
    const nep = nepServer();
    await installeer(opties(), { start: nep.start });
    const u = await installeer(opties({ doel: join(dir, "elders", "lab-lead-hooks") }), { start: nep.start });
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("blok: wordt vervangen");
    expect(u.stdout).toContain(`vertrouwd: ${EVENTS.length} hook(s)`);
    expect(readFileSync(`${cfg}.voor-peerbus`, "utf8")).toBe('model = "x"\n');
    expect(readFileSync(cfg, "utf8")).toContain(join(dir, "elders"));
  });

  test("M1: na de installer ziet controleerGrenzen een vertrouwde grenzen-hook; zonder trust, zonder entry of met een kapotte hash niet", async () => {
    writeFileSync(cfg, 'model = "x"\n');
    const nep = nepServer();
    expect(controleerGrenzen(cfg)).toMatch(/geen PreToolUse-hooks/);
    await installeer(opties(), { start: nep.start });
    expect(controleerGrenzen(cfg)).toBeNull();
    const heel = readFileSync(cfg, "utf8");
    // trust van de grenzen-groep (groep 1) weg: niet vertrouwd, ook al staat de hook van groep 0 wel vertrouwd
    const zonderTrust = heel.replace(/\[hooks\.state\."[^"]*:pre_tool_use:1:0"\]\ntrusted_hash = "[^"]+"\n/, "");
    expect(zonderTrust).not.toBe(heel);
    writeFileSync(cfg, zonderTrust);
    expect(controleerGrenzen(cfg)).toMatch(/niet vertrouwd/);
    writeFileSync(cfg, heel.replace(/(pre_tool_use:1:0"\]\ntrusted_hash = ")sha256:[0-9a-f]+/, "$1sha256:kapot"));
    expect(controleerGrenzen(cfg)).toMatch(/niet vertrouwd/);
    // zonder grenzen-entry
    writeFileSync(cfg, heel.replaceAll("grenzen.sh", "iets-anders.sh"));
    expect(controleerGrenzen(cfg)).toMatch(/ontbreekt/);
    // matcher dekt apply_patch niet
    writeFileSync(cfg, heel.replace(`matcher = ${JSON.stringify(GRENZEN_MATCHER)}`, 'matcher = "Bash"'));
    expect(controleerGrenzen(cfg)).toMatch(/matcher .* dekt Bash en apply_patch niet/);
    expect(controleerGrenzen(join(dir, "weg.toml"))).toMatch(/bestaat niet/);
    // e) de matcher is geanker: "h" dekt Bash en apply_patch niet, ".*" en "Bash|apply_patch|Edit" wel
    writeFileSync(cfg, heel.replace(`matcher = ${JSON.stringify(GRENZEN_MATCHER)}`, 'matcher = "h"'));
    expect(controleerGrenzen(cfg)).toMatch(/matcher .* dekt Bash en apply_patch niet/);
    writeFileSync(cfg, heel.replace(`matcher = ${JSON.stringify(GRENZEN_MATCHER)}`, 'matcher = ".*"'));
    expect(controleerGrenzen(cfg)).toBeNull();
    writeFileSync(cfg, "[[hooks.PreToolUse\n");
    expect(controleerGrenzen(cfg)).toMatch(/geen geldige TOML/);
  });

  test("a) alleen het exacte installer-commando telt: een commando dat de tekst grenzen.sh noemt met een nep-hash gaat niet door", async () => {
    writeFileSync(cfg, 'model = "x"\n');
    const nep = nepServer();
    await installeer(opties(), { start: nep.start });
    const heel = readFileSync(cfg, "utf8");
    const echt = commando(opties().doel, process.execPath, "grenzen.sh");
    expect(heel).toContain(JSON.stringify(echt).slice(1, -1));
    const nepHash = `sha256:${"a".repeat(64)}`;
    for (const vals of [`true ${opties().doel}/grenzen.sh`, `${echt} extra`, `env LAB_LEAD_BUN=${process.execPath} /bin/true ${opties().doel}/grenzen.sh`, `echo lab-lead-hooks/grenzen.sh`]) {
      const stuk = heel.replace(JSON.stringify(echt), JSON.stringify(vals));
      expect(stuk).not.toBe(heel);
      writeFileSync(cfg, stuk);
      expect(controleerGrenzen(cfg)).toMatch(/niet dat van codex-installeer\.ts|ontbreekt/);
    }
    writeFileSync(cfg, `[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "true lab-lead-hooks/grenzen.sh"\n\n[hooks.state."${realpathSync(cfg)}:pre_tool_use:0:0"]\ntrusted_hash = "${nepHash}"\n`);
    expect(controleerGrenzen(cfg)).toMatch(/niet dat van codex-installeer\.ts/);
  });

  test("a/c) ontbrekende of niet-uitvoerbare delen en een verouderde kopie van grenzen.sh, codex-wrap of register.ts worden gevonden", async () => {
    writeFileSync(cfg, 'model = "x"\n');
    const nep = nepServer();
    await installeer(opties(), { start: nep.start });
    expect(controleerGrenzen(cfg)).toBeNull();
    const doel = opties().doel;
    // niet uitvoerbaar / weg
    chmodSync(join(doel, "grenzen.sh"), 0o644);
    expect(controleerGrenzen(cfg)).toMatch(/grenzen\.sh is niet uitvoerbaar/);
    chmodSync(join(doel, "grenzen.sh"), 0o755);
    chmodSync(join(doel, "codex-wrap.sh"), 0o644);
    expect(controleerGrenzen(cfg)).toMatch(/codex-wrap\.sh is niet uitvoerbaar/);
    chmodSync(join(doel, "codex-wrap.sh"), 0o755);
    rmSync(join(doel, "grenzen.sh"));
    expect(controleerGrenzen(cfg)).toMatch(/grenzen\.sh ontbreekt/);
    // een afwijkende kopie (de trust-hash dekt de inhoud niet)
    for (const b of GELIJK_AAN_REPO) {
      await installeer(opties(), { start: nep.start });
      expect(controleerGrenzen(cfg)).toBeNull();
      writeFileSync(join(doel, b), `${readFileSync(join(BRON, b), "utf8")}\n# oud\n`, { mode: 0o755 });
      expect(controleerGrenzen(cfg)).toMatch(new RegExp(`geïnstalleerde ${b.replace(".", "\\.")} .* wijkt af van de repo.*codex-installeer|wijkt af van de repo`));
    }
    // opnieuw installeren herstelt het
    await installeer(opties(), { start: nep.start });
    expect(controleerGrenzen(cfg)).toBeNull();
    // een bun die niet bestaat
    await installeer(opties({ bun: join(dir, "geen-bun") }), { start: nep.start });
    expect(controleerGrenzen(cfg)).toMatch(/bun ontbreekt/);
  });

  test("woorden: splitst zoals shq quote (spaties in een pad, een aanhalingsteken)", () => {
    expect(woorden("env A=1 /x/y /z")).toEqual(["env", "A=1", "/x/y", "/z"]);
    expect(woorden("env A='een map/x' '/m m/a'")).toEqual(["env", "A=een map/x", "/m m/a"]);
    expect(woorden(`'a'\\''b' c`)).toEqual(["a'b", "c"]);
    expect(woorden("'open")).toBeNull();
  });

  test("zonder bestaande config.toml: wordt aangemaakt, geen backup", async () => {
    const nep = nepServer();
    // de nep leest de config na het schrijven, dus het bestand ontstaat door de installer
    const u = await installeer(opties(), { start: nep.start });
    expect(u.code).toBe(0);
    expect(existsSync(cfg)).toBe(true);
    expect(existsSync(`${cfg}.voor-peerbus`)).toBe(false);
    expect(u.stdout).toContain("geen (er is nog geen config.toml)");
  });

  test("app-server start niet: fout met uitleg, hooks staan er wel, exit 1", async () => {
    writeFileSync(cfg, "");
    const u = await installeer(opties(), { start: async () => { throw new Error("spawn codex ENOENT"); } });
    expect(u.code).toBe(1);
    expect(u.stderr).toContain("nog niet vertrouwd");
    expect(u.stderr).toContain("ENOENT");
    expect(blokIn(readFileSync(cfg, "utf8"))).not.toBeNull();
  });

  test("Codex ziet minder hooks dan verwacht, of vertrouwen blijft hangen: fout", async () => {
    writeFileSync(cfg, "");
    const leeg = async (): Promise<AppServer> => ({ hooks: async () => [], vertrouw: async () => {}, sluit() {} });
    expect((await installeer(opties(), { start: leeg })).stderr).toContain("Codex ziet 0 eigen hooks");
    const nep = nepServer();
    const stuk = async (): Promise<AppServer> => ({ ...(await nep.start()), vertrouw: async () => {} });
    const u = await installeer(opties(), { start: stuk });
    expect(u.code).toBe(1);
    expect(u.stderr).toContain("nog niet vertrouwd");
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
    const nep = nepServer();
    await installeer(opties(), { start: nep.start });
    const u = await installeer(opties({ verwijder: true }), { start: nep.start });
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
