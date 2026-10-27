// Installeert de lead-hooks voor Codex (0.164.0) in $CODEX_HOME/config.toml, mét blijvend vertrouwen.
//
//   bun scripts/lead/hooks/codex-installeer.ts [--droog] [--verwijder] [--codex-home <map>] [--doel <map>] [--codex <pad>]
//
//   --droog        print het blok, de te kopiëren bestanden en wat er vertrouwd zou worden; schrijft niets
//   --verwijder    haalt het eigen blok weg (de gekopieerde bestanden en de trust-tabellen blijven staan)
//   --codex-home   standaard $CODEX_HOME, anders ~/.codex
//   --doel         standaard <codex-home>/hooks/lab-lead-hooks
//   --codex        het codex-programma (standaard `codex` uit PATH); voor tests
//
// Hoe vertrouwen werkt in Codex 0.164.0 (uitgezocht met een tijdelijke CODEX_HOME): een hook uit config.toml draait pas
// als `[hooks.state."<pad config.toml>:<event>:<groep>:<handler>"] trusted_hash = "sha256:…"` klopt met de hash van de
// hookdefinitie (hooks/list geeft key, currentHash en trustStatus: untrusted | trusted | modified | managed). Zonder dat
// draaien hooks stil niet; `-c hooks…` op de opdrachtregel werkt niet; `--dangerously-bypass-hook-trust` gebruiken we niet.
// De installer schrijft daarom (1) het blok met hooks tussen markeringen, en (2) vraagt `codex app-server` de hashes te
// berekenen (hooks/list) en ze vast te leggen (config/value/write op hooks.state). Elke run is idempotent: een
// ongewijzigd blok en bestaand vertrouwen geven geen schrijfactie. Voor de eerste schrijfactie komt een backup
// `config.toml.voor-peerbus` (een bestaande backup, de oorspronkelijke, blijft staan). Wijzigt het commando (nieuw pad),
// dan wordt de hash `modified` en zet een volgende run hem weer op vertrouwd.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type AppServer, type HookInfo, startAppServer } from "./codex-appserver";

export const START = "# >>> lab-peerbus hooks (beheerd door codex-installeer.ts; niet met de hand wijzigen) >>>";
export const EINDE = "# <<< lab-peerbus hooks <<<";
export const MERK = "lab-lead-hooks/codex-wrap.sh";
export const BESTANDEN = ["hook.sh", "hook.ts", "register.ts", "codex-adapter.ts", "codex-wrap.sh", "codex-wrap.ts"];
const TOOLS = "WebFetch|WebSearch|mcp__.*|Bash|apply_patch";

type EventSpec = { event: string; matcher?: string; timeout: number };
export const EVENTS: EventSpec[] = [
  { event: "SessionStart", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "PreToolUse", matcher: ".*", timeout: 5 },
  { event: "PostToolUse", matcher: TOOLS, timeout: 5 },
  { event: "Stop", timeout: 5 },
  { event: "SessionEnd", timeout: 2 },
];

export type Opties = { droog: boolean; verwijder: boolean; codexHome: string; doel: string; bun: string; codex: string; bron: string };
export type Uitslag = { code: number; stdout: string; stderr: string };
export type Deps = { start?: (codex: string, home: string, cwd: string) => Promise<AppServer> };

const shq = (s: string) => (/^[A-Za-z0-9_/.:@+=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

export function commando(doel: string, bun: string): string {
  return `env LAB_LEAD_BUN=${shq(bun)} ${shq(join(doel, "codex-wrap.sh"))} ${shq(join(doel, "hook.sh"))} --bron codex`;
}

export function maakBlok(o: Pick<Opties, "doel" | "bun">): string {
  const regels = [START];
  for (const e of EVENTS) {
    regels.push(`[[hooks.${e.event}]]`);
    if (e.matcher) regels.push(`matcher = ${JSON.stringify(e.matcher)}`);
    regels.push(`[[hooks.${e.event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(commando(o.doel, o.bun))}`, `timeout = ${e.timeout}`, "");
  }
  regels.push(EINDE);
  return regels.join("\n");
}

/**
 * Zet `blok` in de tekst: een bestaand blok wordt op zijn plaats vervangen, anders komt het achteraan. Trust-tabellen
 * (`[hooks.state…]`) die Codex zelf tussen de markeringen schreef, blijven behouden (ze komen direct na het blok).
 * `blok === null` haalt het blok weg.
 */
export function zetBlok(tekst: string, blok: string | null): string {
  const a = tekst.indexOf(START);
  const b = a >= 0 ? tekst.indexOf(EINDE, a) : -1;
  if (a >= 0 && b >= 0) {
    const binnen = tekst.slice(a + START.length, b);
    const m = /^\[hooks\.state/m.exec(binnen);
    const bewaard = m ? binnen.slice(m.index).trimEnd() : "";
    const voor = tekst.slice(0, a);
    const na = tekst.slice(b + EINDE.length).replace(/^\n/, "");
    const midden = [blok ?? "", bewaard].filter(Boolean).join("\n\n");
    return `${voor}${midden}${midden ? "\n" : ""}${na}`;
  }
  if (blok === null) return tekst;
  const sep = tekst === "" ? "" : tekst.endsWith("\n") ? "\n" : "\n\n";
  return `${tekst}${sep}${blok}\n`;
}

/** Het eigen blok (van START tot en met EINDE) zoals het in de tekst staat, of null. */
export function blokIn(tekst: string): string | null {
  const a = tekst.indexOf(START);
  const b = a >= 0 ? tekst.indexOf(EINDE, a) : -1;
  return a >= 0 && b >= 0 ? tekst.slice(a, b + EINDE.length) : null;
}

const eigenHook = (h: HookInfo) => typeof h.command === "string" && h.command.includes(MERK);
const nietVertrouwd = (h: HookInfo) => h.trustStatus !== "trusted" && h.trustStatus !== "managed";

function schrijfAtomair(pad: string, inhoud: string, modus: number): void {
  const echt = existsSync(pad) ? realpathSync(pad) : pad;
  const tmp = `${echt}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, inhoud, { mode: modus });
    renameSync(tmp, echt);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export async function installeer(o: Opties, deps: Deps = {}): Promise<Uitslag> {
  const cfg = join(o.codexHome, "config.toml");
  const backup = `${cfg}.voor-peerbus`;
  const uit: string[] = [];
  const fout = (m: string): Uitslag => ({ code: 1, stdout: uit.join("\n"), stderr: `codex-installeer: ${m}\n` });
  if (!existsSync(o.codexHome)) return fout(`CODEX_HOME bestaat niet: ${o.codexHome} (draai eerst codex, of geef --codex-home)`);
  if (!o.verwijder) for (const b of BESTANDEN) if (!existsSync(join(o.bron, b))) return fout(`bronbestand ontbreekt: ${join(o.bron, b)}`);

  const bestondVoor = existsSync(cfg);
  const oud = bestondVoor ? readFileSync(cfg, "utf8") : "";
  // Alleen het blok zelf telt: Codex schrijft de trust-tabellen eromheen en dat mag geen wijziging lijken.
  const gewenst = o.verwijder ? null : maakBlok(o);
  const verandert = blokIn(oud) !== gewenst;
  const nieuw = verandert ? zetBlok(oud, gewenst) : oud;
  const dr = o.droog ? "droog: " : "";
  uit.push(`${dr}config: ${cfg}${existsSync(cfg) ? "" : " (bestaat nog niet)"}`);
  uit.push(`${dr}blok: ${verandert ? (o.verwijder ? "wordt weggehaald" : blokIn(oud) !== null ? "wordt vervangen" : "wordt toegevoegd") : "ongewijzigd"}`);
  if (!o.verwijder) {
    uit.push(`${dr}te kopiëren naar ${o.doel}:`, ...BESTANDEN.map((b) => `  ${join(o.bron, b)} -> ${join(o.doel, b)}`));
    uit.push(`${dr}hookcommando: ${commando(o.doel, o.bun)}`);
    uit.push(`${dr}events: ${EVENTS.map((e) => e.event).join(", ")}`);
  }
  uit.push(`${dr}backup: ${existsSync(backup) ? `${backup} bestaat al en blijft staan` : existsSync(cfg) ? `${backup} wordt gemaakt vóór de eerste wijziging` : "geen (er is nog geen config.toml)"}`);
  if (o.droog) {
    uit.push("droog: daarna vraagt de installer `codex app-server` de hooks (hooks/list) en legt de hash van elke eigen hook vast (config/value/write op hooks.state)", "droog: er is niets geschreven");
    return { code: 0, stdout: `${uit.join("\n")}\n`, stderr: "" };
  }

  if (!o.verwijder) {
    mkdirSync(o.doel, { recursive: true, mode: 0o700 });
    for (const b of BESTANDEN) {
      copyFileSync(join(o.bron, b), join(o.doel, b));
      if (b.endsWith(".sh")) chmodSync(join(o.doel, b), 0o755);
    }
  }
  const maakBackup = () => {
    if (bestondVoor && !existsSync(backup)) {
      copyFileSync(cfg, backup);
      chmodSync(backup, 0o600);
      uit.push(`backup: ${backup}`);
    }
  };
  if (verandert) {
    maakBackup();
    schrijfAtomair(cfg, nieuw, existsSync(cfg) ? statSync(cfg).mode & 0o777 : 0o600);
    uit.push(`geschreven: ${cfg}`);
  }
  if (o.verwijder) return { code: 0, stdout: `${uit.join("\n")}\n`, stderr: "" };

  // Vertrouwen: hashes door Codex zelf laten berekenen en vastleggen.
  const start = deps.start ?? ((c, h, w) => startAppServer(c, h, w));
  let server: AppServer;
  try {
    server = await start(o.codex, o.codexHome, o.codexHome);
  } catch (e) {
    return fout(`codex app-server startte niet (${(e as Error).message}). De hooks staan in ${cfg} maar zijn nog niet vertrouwd; draai de installer opnieuw als codex werkt.`);
  }
  try {
    const eigen = (await server.hooks(o.codexHome)).filter(eigenHook);
    if (eigen.length !== EVENTS.length) return fout(`Codex ziet ${eigen.length} eigen hooks, verwacht ${EVENTS.length}; controleer ${cfg}`);
    const open = eigen.filter(nietVertrouwd);
    if (open.length > 0) {
      maakBackup();
      await server.vertrouw(Object.fromEntries(open.map((h) => [h.key, h.currentHash])));
      uit.push(`vertrouwd: ${open.length} hook(s): ${open.map((h) => h.eventName).join(", ")}`);
    } else uit.push("vertrouwen: alle eigen hooks waren al vertrouwd");
    const controle = (await server.hooks(o.codexHome)).filter(eigenHook).filter(nietVertrouwd);
    if (controle.length > 0) return fout(`na het vastleggen zijn nog niet vertrouwd: ${controle.map((h) => `${h.eventName} (${h.trustStatus})`).join(", ")}`);
    uit.push(`klaar: ${EVENTS.length} hooks vertrouwd in ${cfg}`);
  } catch (e) {
    return fout((e as Error).message);
  } finally {
    server.sluit();
  }
  return { code: 0, stdout: `${uit.join("\n")}\n`, stderr: "" };
}

export function leesArgs(argv: string[], env: { [k: string]: string | undefined }, bron: string): Opties | string {
  const home = env.HOME || homedir();
  const o: Opties = { droog: false, verwijder: false, codexHome: env.CODEX_HOME || join(home, ".codex"), doel: "", bun: process.execPath, codex: "codex", bron };
  let doel = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const w = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} mist een waarde`);
      return v;
    };
    try {
      if (a === "--droog") o.droog = true;
      else if (a === "--verwijder") o.verwijder = true;
      else if (a === "--codex-home") o.codexHome = resolve(w());
      else if (a === "--doel") doel = resolve(w());
      else if (a === "--codex") o.codex = w();
      else if (a === "--bun") o.bun = resolve(w());
      else return `onbekende optie: ${a}`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  o.doel = doel || join(o.codexHome, "hooks", "lab-lead-hooks");
  if (!o.doel.endsWith("lab-lead-hooks")) return "--doel moet op lab-lead-hooks eindigen";
  return o;
}

if (import.meta.main) {
  const o = leesArgs(process.argv.slice(2), process.env, dirname(import.meta.path));
  if (typeof o === "string") {
    process.stderr.write(`${o}\ngebruik: codex-installeer.ts [--droog] [--verwijder] [--codex-home <map>] [--doel <map>] [--codex <pad>]\n`);
    process.exit(1);
  }
  const u = await installeer(o);
  if (u.stdout) process.stdout.write(u.stdout);
  if (u.stderr) process.stderr.write(u.stderr);
  process.exit(u.code);
}
