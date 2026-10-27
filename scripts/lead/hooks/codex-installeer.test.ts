import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppServer, HookInfo } from "./codex-appserver";
import { EINDE, EVENTS, START, blokIn, commando, installeer, leesArgs, maakBlok, zetBlok, type Opties } from "./codex-installeer";

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

const opties = (extra: Partial<Opties> = {}): Opties => ({ droog: false, verwijder: false, codexHome: home, doel: join(home, "hooks", "lab-lead-hooks"), bun: "/usr/local/bin/bun", codex: "codex", bron: BRON, ...extra });
const snake = (e: string) => e.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

/** Nep van `codex app-server`: leest de hooks uit config.toml, rekent een hash uit het commando en legt vertrouwen vast als tabel. */
function nepServer(): { start: () => Promise<AppServer>; log: string[] } {
  const log: string[] = [];
  const start = async (): Promise<AppServer> => ({
    async hooks() {
      const tekst = readFileSync(cfg, "utf8");
      const uit: HookInfo[] = [];
      let event = "";
      for (const regel of tekst.split("\n")) {
        const e = /^\[\[hooks\.([A-Za-z]+)\]\]$/.exec(regel);
        if (e) event = e[1];
        const c = /^command = (".*")$/.exec(regel);
        if (c && event) {
          const command = JSON.parse(c[1]) as string;
          const key = `${cfg}:${snake(event)}:0:0`;
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
    for (const b of ["hook.sh", "hook.ts", "register.ts", "codex-adapter.ts", "codex-wrap.sh", "codex-wrap.ts"]) expect(existsSync(join(home, "hooks/lab-lead-hooks", b))).toBe(true);
    expect(statSync(join(home, "hooks/lab-lead-hooks/codex-wrap.sh")).mode & 0o100).toBeTruthy();
    // de peerbus voor hook.ts (laadPeers): peers/ en een tweede register.ts onder hooks/
    for (const b of ["bus.ts", "standaard.ts", "types.ts", "uuid.ts"]) expect(existsSync(join(home, "hooks/lab-lead-hooks/peers", b))).toBe(true);
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
});
