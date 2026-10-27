// Installeert de lead-hooks (scripts/lead/hooks/) in Claude Code-settings.
//
//   bun scripts/lead/installeer-hooks.ts [--droog] [--verwijder] [--met-wekker]
//                                        [--settings <pad>] [--doel <map>]
//
//   --droog        print de diff van `.hooks` en de te kopiëren bestanden; schrijft niets
//   --verwijder    haalt precies de eigen entries weg (en laat het gekopieerde script staan)
//   --met-wekker   extra Stop-entry met asyncRewake (H11, timeout 1900 s)
//   --settings     standaard ~/.claude/settings.json
//   --doel         standaard ~/.claude/hooks/lab-lead-hooks (moet op `lab-lead-hooks` eindigen)
//
// Alleen `.hooks` wordt aangeraakt. Eigen entries zijn herkenbaar aan `lab-lead-hooks/hook.sh` in het
// commando, dus installeren is idempotent (een eigen entry wordt op zijn plaats vervangen) en
// bestaande entries blijven gelijk. Voor het schrijven komt er een backup
// `<settings>.voor-lead-hooks-<stempel>`; het schrijven is atomair (tmp + rename) en daarna wordt
// de JSON opnieuw gelezen. Een symlink blijft een symlink (het echte doel wordt herschreven) en de
// modus van het bestaande bestand blijft behouden (nieuw bestand: 600); faalt het schrijven, dan
// wordt het tmp-bestand opgeruimd. De opmaak van settings.json wordt herschreven met 2 spaties inspringing.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { beleid } from "./beleid/beleid";
import { MERK, WEKKER_TIMEOUT, claudeSpecs, commando, genereer, nieuweHooks as nieuweHooksUitBron } from "./beleid/claude";
import { peersKopieen } from "./hooks/peers-kopie";

export { MERK, WEKKER_TIMEOUT, commando };
export const BESTANDEN = ["hook.sh", "hook.ts", "register.ts", "codex-adapter.ts"];

type Json = { [k: string]: unknown };

/** De events die de lead-hooks krijgen, uit de bron (beleid/beleid.ts) vertaald voor Claude. */
export type EventSpec = { event: string; matcher?: string; timeout: number };
export const EVENTS: EventSpec[] = claudeSpecs(beleid, {})
  .filter((s) => s.hook.script === "lead-hook")
  .map(({ event, matcher, timeout }) => ({ event, ...(matcher === undefined ? {} : { matcher }), timeout }));

export type Opties = {
  droog: boolean;
  verwijder: boolean;
  metWekker: boolean;
  settings: string;
  doel: string;
  bun: string;
  nu: Date;
  /** Map met hook.sh, hook.ts en register.ts. */
  bron: string;
};
export type Uitslag = { code: number; stdout: string; stderr: string };

/** Pure functie: de nieuwe `.hooks` voor een bestaande (de generator in beleid/claude.ts). */
export function nieuweHooks(oud: unknown, o: Pick<Opties, "doel" | "bun" | "metWekker" | "verwijder">): Json | undefined {
  return nieuweHooksUitBron(oud, claudeSpecs(beleid, {}), o);
}

/** Eenvoudige regel-diff (LCS); genoeg voor een paar honderd regels JSON. */
export function lijnDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const uit: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      uit.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) uit.push(`- ${a[i++]}`);
    else uit.push(`+ ${b[j++]}`);
  }
  while (i < n) uit.push(`- ${a[i++]}`);
  while (j < m) uit.push(`+ ${b[j++]}`);
  return uit;
}

const stempel = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.(\d{3})Z$/, "$1");

export function installeer(o: Opties): Uitslag {
  const fout = (m: string): Uitslag => ({ code: 1, stdout: "", stderr: `installeer-hooks: ${m}\n` });
  if (basename(resolve(o.doel)) !== "lab-lead-hooks") return fout("--doel moet op `lab-lead-hooks` eindigen, anders herkent --verwijder de entries niet");
  let origineel: Json = {};
  const bestaat = existsSync(o.settings);
  if (bestaat) {
    try {
      const p = JSON.parse(readFileSync(o.settings, "utf8"));
      if (typeof p !== "object" || p === null || Array.isArray(p)) return fout(`${o.settings} is geen JSON-object`);
      origineel = p;
    } catch (e) {
      return fout(`${o.settings} is geen geldige JSON (${(e as Error).message}); niets aangepast`);
    }
  } else if (o.verwijder) return { code: 0, stdout: `${o.settings} bestaat niet; niets te verwijderen\n`, stderr: "" };

  let nieuw: Json;
  try {
    const g = genereer(beleid, "claude", { doel: o.doel, bun: o.bun, metWekker: o.metWekker, verwijder: o.verwijder, settings: o.settings, bestaand: origineel });
    nieuw = JSON.parse(g.bestanden[0]!.inhoud) as Json;
  } catch (e) {
    return fout(`${(e as Error).message}; niets aangepast`);
  }
  const hooks = nieuw.hooks as Json | undefined;

  const oudTekst = JSON.stringify(origineel.hooks ?? {}, null, 2).split("\n");
  const nieuwTekst = JSON.stringify(hooks ?? {}, null, 2).split("\n");
  const gelijk = JSON.stringify(origineel.hooks ?? null) === JSON.stringify(hooks ?? null);
  const kopieer = !o.verwijder;
  const diff = gelijk ? ["(geen wijziging in .hooks)"] : lijnDiff(oudTekst, nieuwTekst);
  const regels = [
    `${o.droog ? "droog: " : ""}settings: ${o.settings}${bestaat ? "" : " (bestaat nog niet)"}`,
    `bun: ${o.bun}`,
    ...(kopieer ? [`te kopiëren naar ${o.doel}:`, ...BESTANDEN.map((b) => `  ${join(o.bron, b)} -> ${join(o.doel, b)}`), ...peersKopieen(o.bron, o.doel).map(([van, naar]) => `  ${van} -> ${naar}`)] : ["--verwijder: de bestanden in het doel blijven staan"]),
    ".hooks (diff):",
    ...diff,
  ];
  if (o.droog) return { code: 0, stdout: `${regels.join("\n")}\ndroog: er is niets geschreven\n`, stderr: "" };

  if (kopieer) {
    for (const b of BESTANDEN) if (!existsSync(join(o.bron, b))) return fout(`bronbestand ontbreekt: ${join(o.bron, b)}`);
    for (const [van] of peersKopieen(o.bron, o.doel)) if (!existsSync(van)) return fout(`bronbestand ontbreekt: ${van}`);
    mkdirSync(o.doel, { recursive: true, mode: 0o700 });
    for (const b of BESTANDEN) copyFileSync(join(o.bron, b), join(o.doel, b));
    for (const [van, naar] of peersKopieen(o.bron, o.doel)) {
      mkdirSync(dirname(naar), { recursive: true, mode: 0o700 });
      copyFileSync(van, naar);
    }
    chmodSync(join(o.doel, "hook.sh"), 0o755);
  }
  if (!gelijk) {
    mkdirSync(dirname(o.settings), { recursive: true });
    // Een symlink blijft een symlink: schrijf naar het echte doel, met backup en tmp in dezelfde map (atomaire rename).
    const doelPad = bestaat ? realpathSync(o.settings) : o.settings;
    const modus = bestaat ? statSync(doelPad).mode & 0o777 : 0o600;
    if (bestaat) {
      const backup = `${doelPad}.voor-lead-hooks-${stempel(o.nu)}`;
      copyFileSync(doelPad, backup);
      chmodSync(backup, modus);
      regels.push(`backup: ${backup}`);
    }
    const tmp = `${doelPad}.lead-hooks-tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(nieuw, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, modus);
      renameSync(tmp, doelPad);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    try {
      JSON.parse(readFileSync(o.settings, "utf8"));
    } catch (e) {
      return fout(`na het schrijven is ${o.settings} geen geldige JSON (${(e as Error).message}); herstel met de backup`);
    }
  }
  regels.push(gelijk ? "klaar: settings.json was al in orde, niet herschreven" : "klaar: settings.json bijgewerkt en gecontroleerd");
  return { code: 0, stdout: `${regels.join("\n")}\n`, stderr: "" };
}

export function leesArgs(argv: string[], home = homedir()): Omit<Opties, "bun" | "nu" | "bron"> | string {
  const o = { droog: false, verwijder: false, metWekker: false, settings: join(home, ".claude", "settings.json"), doel: join(home, ".claude", "hooks", "lab-lead-hooks") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--droog") o.droog = true;
    else if (a === "--verwijder") o.verwijder = true;
    else if (a === "--met-wekker") o.metWekker = true;
    else if (a === "--settings" || a === "--doel") {
      const w = argv[++i];
      if (!w) return `${a} heeft een waarde nodig`;
      if (a === "--settings") o.settings = resolve(w);
      else o.doel = resolve(w);
    } else return `onbekende optie: ${a}`;
  }
  if (o.verwijder && o.metWekker) return "--verwijder en --met-wekker sluiten elkaar uit";
  return o;
}

/**
 * Stabiel bun-pad voor de hooks: `bun` uit PATH (bv. /opt/homebrew/bin/bun, een symlink die een `brew upgrade` overleeft).
 * Het versiepad van het draaiende proces (process.execPath, bv. .../Cellar/bun/1.4.2/bin/bun) is de laatste terugval.
 */
export function kiesBun(which: (n: string) => string | null = (n) => Bun.which(n), execPath: string = process.execPath): string {
  const gevonden = which("bun");
  return gevonden && isAbsolute(gevonden) ? gevonden : execPath;
}

if (import.meta.main) {
  const a = leesArgs(process.argv.slice(2));
  if (typeof a === "string") {
    console.error(`installeer-hooks: ${a}`);
    process.exit(1);
  }
  const bun = kiesBun();
  const u = installeer({ ...a, bun, nu: new Date(), bron: join(import.meta.dir, "hooks") });
  process.stdout.write(u.stdout);
  process.stderr.write(u.stderr);
  process.exit(u.code);
}
