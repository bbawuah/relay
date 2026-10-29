// Claude-generator: pure functie van de beleidsbron naar `~/.claude/settings.json` (alleen `.hooks`).
// Schrijft niets en leest niets; de installer (installeer-hooks.ts) doet de bestanden.
//
// Eigen entries zijn herkenbaar aan lab-lead-hooks/hook.sh; andere entries blijven ongemoeid.

import { join } from "node:path";
import { hosts } from "./hosts";
import type { Beleid, Hook, Host } from "./typen";

export const MERK = "lab-lead-hooks/hook.sh";
export const WEKKER_TIMEOUT = 1900;

type HookCfg = { type?: string; command?: string; timeout?: number; asyncRewake?: boolean; [k: string]: unknown };
type Groep = { matcher?: string; hooks?: HookCfg[]; [k: string]: unknown };
type Json = { [k: string]: unknown };

export type ClaudeOpties = {
  /** Map van hook.sh (eindigt op `lab-lead-hooks`). */
  doel: string;
  bun: string;
  /** Extra Stop-entry met asyncRewake (H11). */
  metWekker: boolean;
  verwijder: boolean;
  /** Pad van settings.json en de huidige inhoud (geparst; ontbreekt = nieuw bestand). */
  settings: string;
  bestaand?: Json;
  /** Bestaat dit pad? Voor `alsBestaat`; standaard ja. */
  bestaat?: (pad: string) => boolean;
};

export type Spec = { event: string; matcher?: string; timeout: number; hook: Hook };

const shq = (s: string) => (/^[A-Za-z0-9_/.:@+=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const kopie = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function commando(doel: string, bun: string, arg = ""): string {
  return `LAB_LEAD_BUN=${shq(bun)} ${shq(join(doel, "hook.sh"))}${arg ? ` ${arg}` : ""}`;
}

/** De hooks voor Claude, in de volgorde van de bron, met hostevent en matcher uit de vertaaltabel. */
export function claudeSpecs(beleid: Beleid, o: Pick<ClaudeOpties, "bestaat">, waarschuwingen: string[] = []): Spec[] {
  const t = hosts.claude;
  if (!t) throw new Error("hosts.claude ontbreekt");
  const uit: Spec[] = [];
  for (const h of beleid.hooks) {
    if (h.hosts && !h.hosts.includes("claude")) continue;
    if (h.script !== "lead-hook") {
      waarschuwingen.push(`hook ${h.id}: script ${h.script} is nog niet in de Claude-generator; overgeslagen`);
      continue;
    }
    if (h.alsBestaat && !(o.bestaat ?? (() => true))(h.alsBestaat)) {
      waarschuwingen.push(`hook ${h.id}: ${h.alsBestaat} bestaat niet; overgeslagen`);
      continue;
    }
    const event = t.events[h.event];
    if (event === null) {
      waarschuwingen.push(`hook ${h.id}: event ${h.event} bestaat niet in Claude; overgeslagen`);
      continue;
    }
    let matcher: string | undefined = t.eventMatcher[h.event];
    if (h.event === "voor-tool" || h.event === "na-tool") {
      const delen: string[] = [];
      for (const k of h.tools ?? ["alle"]) {
        const m = t.tools[k];
        if (m === null) waarschuwingen.push(`hook ${h.id}: toolklasse ${k} bestaat niet in Claude; overgeslagen`);
        else delen.push(m);
      }
      if (!delen.length) continue;
      matcher = delen.join("|");
    }
    uit.push({ event, ...(matcher === undefined ? {} : { matcher }), timeout: h.timeoutS, hook: h });
  }
  return uit;
}

function commandoVoor(spec: Spec, o: Pick<ClaudeOpties, "doel" | "bun">): string {
  return commando(o.doel, o.bun);
}

function eigenGroepen(o: Pick<ClaudeOpties, "doel" | "bun" | "metWekker">, spec: Spec): Groep[] {
  const g: Groep = {};
  if (spec.matcher) g.matcher = spec.matcher;
  g.hooks = [{ type: "command", command: commandoVoor(spec, o), timeout: spec.timeout }];
  const uit = [g];
  if (spec.event === "Stop" && spec.hook.script === "lead-hook" && o.metWekker) {
    uit.push({ hooks: [{ type: "command", command: commando(o.doel, o.bun, "wekker"), timeout: WEKKER_TIMEOUT, asyncRewake: true }] });
  }
  return uit;
}

/** Haalt eigen hooks uit de groepen en zegt waar de eerste stond (in de overgebleven lijst). */
function strip(groepen: Groep[], eigen: (h: HookCfg) => boolean): { rest: Groep[]; pos: number | null } {
  const rest: Groep[] = [];
  let pos: number | null = null;
  for (const g of groepen) {
    const hs = Array.isArray(g.hooks) ? g.hooks : [];
    if (!hs.some(eigen)) {
      rest.push(g);
      continue;
    }
    if (pos === null) pos = rest.length;
    const over = hs.filter((h) => !eigen(h));
    if (over.length) rest.push({ ...g, hooks: over });
  }
  return { rest, pos };
}

/** Pure functie: de nieuwe `.hooks` voor een bestaande. */
export function nieuweHooks(oud: unknown, specs: Spec[], o: Pick<ClaudeOpties, "doel" | "bun" | "metWekker" | "verwijder">): Json | undefined {
  if (oud !== undefined && (typeof oud !== "object" || oud === null || Array.isArray(oud))) throw new Error("`.hooks` in settings.json is geen object");
  const eigen = (h: HookCfg) =>
    typeof h.command === "string" &&
    (h.command.includes(MERK) || /^LAB_BELEID_ID=grenzen(?:[ \t]|$)/.test(h.command.trimStart()));
  const uit: Json = kopie((oud as Json | undefined) ?? {});
  const events = new Set([...specs.map((s) => s.event), ...Object.keys(uit)]);
  for (const ev of events) {
    const huidig = uit[ev];
    const evSpecs = specs.filter((s) => s.event === ev);
    if (huidig !== undefined && !Array.isArray(huidig)) {
      if (evSpecs.length && !o.verwijder) throw new Error(`\`.hooks.${ev}\` in settings.json is geen lijst`);
      continue;
    }
    const heeftEigen = (huidig ?? []).some((g: Groep) => Array.isArray(g.hooks) && g.hooks.some(eigen));
    if (!heeftEigen && (o.verwijder || !evSpecs.length)) continue;
    const { rest, pos } = strip(huidig ?? [], eigen);
    if (!o.verwijder && evSpecs.length) rest.splice(pos ?? rest.length, 0, ...evSpecs.flatMap((s) => eigenGroepen(o, s)));
    if (rest.length) uit[ev] = rest;
    else delete uit[ev];
  }
  return Object.keys(uit).length ? uit : undefined;
}

/** genereer(beleid, "claude", opties): de nieuwe settings.json (alleen `.hooks` verandert) en waarschuwingen. */
export function genereer(beleid: Beleid, host: Host, o: ClaudeOpties): { bestanden: { pad: string; inhoud: string }[]; waarschuwingen: string[] } {
  const waarschuwingen: string[] = [];
  if (host !== "claude") return { bestanden: [], waarschuwingen: [`host ${host}: nog geen generator (fase 2)`] };
  const t = hosts.claude;
  for (const n of t?.nietVertaalbaar ?? []) waarschuwingen.push(n);
  const opties = o;
  const specs = claudeSpecs(beleid, o, waarschuwingen);
  const hooks = nieuweHooks(o.bestaand?.hooks, specs, opties);
  const nieuw: Json = { ...(o.bestaand ?? {}) };
  if (hooks) nieuw.hooks = hooks;
  else delete nieuw.hooks;
  return { bestanden: [{ pad: o.settings, inhoud: `${JSON.stringify(nieuw, null, 2)}\n` }], waarschuwingen };
}
