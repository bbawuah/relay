// Controleert of de grenzen-hook (grenzen.sh) in een Codex-config staat, vertrouwd is en actueel is.
//
//   bun codex-controle.ts [<config.toml>]       exit 0 = in orde, 1 = niet in orde (reden op stderr)
//
// spawn.sh --vendor codex roept dit aan vóór het starten: zonder de PreToolUse-groep voor grenzen.sh (matcher dekt Bash én
// apply_patch) of zonder een geldige `trusted_hash` voor die groep in `hooks.state` draait grenzen.sh stil niet (Codex slaat
// een ongetrust hook over) en gelden de rolregels niet. Controles:
//  - het commando is exact wat codex-installeer.ts schrijft (`commando(doel, bun, "grenzen.sh")`): een ander commando dat de
//    tekst `lab-lead-hooks/grenzen.sh` alleen noemt, telt niet;
//  - de wrapper, grenzen.sh en bun bestaan en zijn uitvoerbaar;
//  - de geïnstalleerde grenzen.sh, codex-wrap.* en register.ts zijn gelijk aan die in de repo: de trusted_hash dekt alleen de
//    hookdefinitie, niet de inhoud van die bestanden, dus een verouderde kopie wordt zo gevonden;
//  - de matcher is geanker: hij moet Bash en apply_patch dekken (een matcher als "h" telt niet).
// Of de hash nog klopt met de hookdefinitie ziet alleen Codex zelf (trustStatus `modified`); na een handmatige wijziging van
// het blok: codex-installeer.ts opnieuw draaien.

import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GRENZEN_MERK, commando } from "./codex-installeer";

type Groep = { matcher?: unknown; hooks?: { command?: unknown }[] };

/** Bestanden waarvan de geïnstalleerde kopie gelijk moet zijn aan de repo (de trust-hash dekt hun inhoud niet). */
export const GELIJK_AAN_REPO = ["grenzen.sh", "codex-wrap.sh", "codex-wrap.ts", "register.ts"];

/** De naam waaronder Codex het vertrouwen van een hook bewaart: `<config.toml>:<event_snake>:<groep>:<handler>`. */
export function vertrouwSleutel(configPad: string, eventSnake: string, groep: number, handler: number): string {
  return `${configPad}:${eventSnake}:${groep}:${handler}`;
}

/** Splitst een shell-commando in woorden; kent alleen spaties en enkele aanhalingstekens (zoals `shq` ze schrijft). */
export function woorden(c: string): string[] | null {
  const uit: string[] = [];
  let w = "";
  let open = false;
  let inQ = false;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (inQ) {
      if (ch === "'") inQ = false;
      else w += ch;
    } else if (ch === "'") {
      inQ = true;
      open = true;
    } else if (ch === "\\" && c[i + 1] === "'") {
      w += "'";
      i++;
    } else if (ch === " ") {
      if (open || w) uit.push(w);
      w = "";
      open = false;
    } else {
      w += ch;
      open = true;
    }
  }
  if (inQ) return null;
  if (open || w) uit.push(w);
  return uit;
}

const uitvoerbaar = (pad: string): boolean => {
  try {
    accessSync(pad, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Is `command` het grenzen-commando van de installer, met bestaande en uitvoerbare delen? null = ja, anders de reden. */
function controleerCommando(command: string, bronMap: string): string | null {
  const w = woorden(command);
  if (!w || w.length !== 4 || w[0] !== "env" || !w[1].startsWith("LAB_LEAD_BUN=")) return "het commando is niet dat van codex-installeer.ts";
  const bun = w[1].slice("LAB_LEAD_BUN=".length);
  const doel = dirname(w[2]);
  if (basename(w[2]) !== "codex-wrap.sh" || w[3] !== join(doel, "grenzen.sh") || basename(doel) !== "lab-lead-hooks" || command !== commando(doel, bun, "grenzen.sh")) {
    return "het commando is niet dat van codex-installeer.ts";
  }
  for (const [naam, pad] of [["bun", bun], ["codex-wrap.sh", w[2]], ["grenzen.sh", w[3]]] as const) {
    if (!existsSync(pad)) return `${naam} ontbreekt: ${pad}`;
    if (!uitvoerbaar(pad)) return `${naam} is niet uitvoerbaar: ${pad}`;
  }
  for (const b of GELIJK_AAN_REPO) {
    const kopie = join(doel, b);
    const bron = join(bronMap, b);
    if (!existsSync(kopie) || !existsSync(bron) || !readFileSync(kopie).equals(readFileSync(bron))) return `de geïnstalleerde ${b} (${kopie}) wijkt af van de repo (verouderde kopie)`;
  }
  return rooktoets(doel, bun);
}

/**
 * Rooktoets: laden de geïnstalleerde wrapper en hook.ts echt vanuit hun eigen map? De bestandscontrole hierboven ziet een import
 * die geïnstalleerd niet bestaat niet (#685: elke Codex-hook faalde dicht terwijl dit exit 0 gaf). De wrapper draait `bun --version`
 * en hook.ts een lege invoer, in een tijdelijke HOME en LAB_LEAD_STAAT. null = in orde, anders de reden.
 */
function rooktoets(doel: string, bun: string): string | null {
  const tmp = mkdtempSync(join(tmpdir(), "codex-rook-"));
  try {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, LAB_LEAD_STAAT: join(tmp, "staat"), LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: bun };
    const proeven: [string, string[]][] = [
      ["codex-wrap.ts", [bun, join(doel, "codex-wrap.ts"), bun, "--version"]],
      ["hook.ts", [bun, join(doel, "hook.ts"), "--bron", "codex"]],
    ];
    for (const [naam, argv] of proeven) {
      const p = Bun.spawnSync(argv, { env, cwd: tmp, stdin: new TextEncoder().encode("{}"), stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      if (p.exitCode !== 0) {
        const regel = p.stderr.toString().split("\n").find((l) => l.trim()) ?? "geen uitvoer";
        return `de geïnstalleerde ${naam} start niet (exit ${p.exitCode}): ${regel.slice(0, 300)}`;
      }
    }
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** null = in orde, anders de reden. `bronMap` is de map met de repo-versies (standaard deze map). */
export function controleerGrenzen(configPad: string, bronMap = import.meta.dir): string | null {
  if (!existsSync(configPad)) return `${configPad} bestaat niet`;
  let toml: { hooks?: { PreToolUse?: Groep[]; state?: Record<string, { trusted_hash?: unknown }> } };
  try {
    toml = Bun.TOML.parse(readFileSync(configPad, "utf8")) as typeof toml;
  } catch (e) {
    return `${configPad} is geen geldige TOML (${(e as Error).message.split("\n")[0]})`;
  }
  const groepen = toml.hooks?.PreToolUse;
  if (!Array.isArray(groepen)) return `${configPad} heeft geen PreToolUse-hooks`;
  const echt = realpathSync(configPad);
  let reden = `de grenzen-hook (${GRENZEN_MERK}) ontbreekt in ${configPad}`;
  for (let g = 0; g < groepen.length; g++) {
    const hooks = Array.isArray(groepen[g]?.hooks) ? groepen[g].hooks! : [];
    for (let h = 0; h < hooks.length; h++) {
      const command = hooks[h]?.command;
      if (typeof command !== "string" || !command.includes(GRENZEN_MERK)) continue;
      const fout = controleerCommando(command, bronMap);
      if (fout) {
        reden = `${fout}; ${configPad}`;
        continue;
      }
      const m = groepen[g].matcher;
      let dekt = false;
      try {
        dekt = typeof m === "string" && ["Bash", "apply_patch"].every((t) => new RegExp(`^(?:${m})$`).test(t));
      } catch {
        dekt = false;
      }
      if (!dekt) {
        reden = `de matcher van de grenzen-hook dekt Bash en apply_patch niet (${JSON.stringify(m)}) in ${configPad}`;
        continue;
      }
      const hash = toml.hooks?.state?.[vertrouwSleutel(echt, "pre_tool_use", g, h)]?.trusted_hash;
      if (typeof hash === "string" && /^sha256:[0-9a-f]{64}$/.test(hash)) return null;
      reden = `de grenzen-hook in ${configPad} is niet vertrouwd (geen geldige trusted_hash in hooks.state)`;
    }
  }
  return reden;
}

/**
 * Hosted web search staat uit voor werkers (het resultaat komt zonder hook binnen). In tmux zet spawn.sh dat met
 * `-c web_search="disabled"`; een T3-thread krijgt geen `-c`, dus daar eist spawn dat de config het niet aanzet.
 * Allowlist: alleen een ontbrekende sleutel of "disabled" (voor `web_search`), of een ontbrekende sleutel of false (voor
 * `tools.web_search` en `features.web_search_request|web_search_cached`) is goed; elke andere waarde weigert.
 * null = goed, anders de reden. `verplicht = false` slaat een ontbrekend bestand over (een project-config is optioneel).
 * Gemeten op codex-cli 0.164.0: `web_search = "disabled"` haalt de tool uit het verzoek; `-c` wint van een
 * `<project>/.codex/config.toml` die hem aanzet (dus in tmux geen risico, in T3 wel: controleer dat bestand ook);
 * een `profile = …` in config.toml wordt niet meer ondersteund (fout), een profiel gaat alleen met `--profile` (spawn geeft
 * dat nooit mee). Niet gecontroleerd: een `--search` of `-p` die Brian zelf meegeeft, en een beheerde requirements.toml.
 */
export function controleerWebSearch(configPad: string, verplicht = true): string | null {
  if (!existsSync(configPad)) return verplicht ? `${configPad} bestaat niet` : null;
  let toml: { web_search?: unknown; tools?: { web_search?: unknown }; features?: Record<string, unknown> };
  try {
    toml = Bun.TOML.parse(readFileSync(configPad, "utf8")) as typeof toml;
  } catch (e) {
    return `${configPad} is geen geldige TOML (${(e as Error).message.split("\n")[0]})`;
  }
  const aan: string[] = [];
  if (toml.web_search !== undefined && toml.web_search !== "disabled") aan.push(`web_search = ${JSON.stringify(toml.web_search)}`);
  if (toml.tools?.web_search !== undefined && toml.tools.web_search !== false) aan.push("tools.web_search");
  for (const k of ["web_search_request", "web_search_cached"]) if (toml.features?.[k] !== undefined && toml.features[k] !== false) aan.push(`features.${k}`);
  if (aan.length === 0) return null;
  return `hosted web search kan voor een T3-thread niet uit: ${configPad} zet hem aan (${aan.join(", ")}) en een T3-thread krijgt geen -c per thread. Zet bovenaan dat bestand web_search = "disabled" (buiten een [sectie]) of haal de instelling weg`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const naPad = (vlag: string) => (args.includes(vlag) ? args[args.indexOf(vlag) + 1] : undefined);
  const project = naPad("--project");
  const pad = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--project") || join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex"), "config.toml");
  const r = controleerGrenzen(pad);
  if (r) {
    process.stderr.write(`${r}\nDraai: bun scripts/lead/hooks/codex-installeer.ts (eerst met --droog)\n`);
    process.exit(1);
  }
  if (args.includes("--web-search")) {
    const w = controleerWebSearch(pad) ?? (project ? controleerWebSearch(join(project, ".codex", "config.toml"), false) : null);
    if (w) {
      process.stderr.write(`${w}\n`);
      process.exit(3);
    }
  }
}
