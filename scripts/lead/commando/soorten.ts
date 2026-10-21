// De allowlist van soorten die Brian via de kaart in Terminal B kan goedkeuren (PLAN §2.2).
// Gedeeld door CLI, server en runner. Een agent vraagt een soort met parameters; argv, cwd en env
// maakt altijd deze module. Geen vrije commando's, geen shell.
import { homedir } from "node:os";
import { inStiltevenster } from "../../stiltevenster";
import type { Ctx } from "./schema";

export type Risico = "laag" | "midden" | "hoog";

export interface Soort {
  id: string;
  risico: Risico;
  zwaar: boolean;
  params: Record<string, RegExp>;
  argv(p: Record<string, string>): string[];
  cwd(p: Record<string, string>, ctx: Ctx): string;
  env(ctx: Ctx): Record<string, string>;
  wat(p: Record<string, string>): string;
  uitvoer: "toon" | "alleen-exit";
  maxPerDag: number;
  timeoutMs: number;
  alleenTest?: boolean;
  /** Regels die een regex niet vangt (bv. tak ≠ main, poort niet live); null = ok. */
  extraCheck?(p: Record<string, string>): string | null;
  /** Omgekeerde van `argv`: de params uit een argv, voor `vraag-brian.ts -- <argv>`. `herken` controleert het resultaat altijd opnieuw. */
  uitArgv?(argv: string[]): Record<string, string> | null;
}

/** Live poorten die geen test of tailnet-actie mag raken (AGENTS.md, plus 8232 de reviewproxy, #364). */
export const LIVE_POORTEN: readonly number[] = [8220, 8230, 8232, 8260, 8448, 8449];

/** https-poorten die de mini al serveert (tailnet-skill): nooit openzetten of dichtdoen via de kaart. */
const BEZETTE_HTTPS: readonly number[] = [80, 443, 6006, 8443, 8446, 8447];

const TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const POORT = /^[1-9][0-9]{3,4}$/;
const PAD = "/opt/homebrew/bin:/usr/bin:/bin";

const vasteEnv = (): Record<string, string> => ({ PATH: PAD, HOME: homedir(), LANG: "en_US.UTF-8" });

/** De https-poorten die een tailnet-regel via de kaart mag krijgen of verliezen (de runner toetst ook `tailscale serve status`). */
const HTTPS_BEREIK: readonly [number, number] = [8440, 8459];

function httpsFout(w: string): string | null {
  const n = Number(w);
  if (n < HTTPS_BEREIK[0] || n > HTTPS_BEREIK[1]) return `https-poort moet in ${HTTPS_BEREIK[0]}–${HTTPS_BEREIK[1]} liggen`;
  return poortFout("https-poort", w, BEZETTE_HTTPS);
}

function poortFout(naam: string, w: string, ook: readonly number[] = []): string | null {
  const n = Number(w);
  if (n < 1024 || n > 65535) return `${naam} moet in 1024–65535 liggen`;
  if (LIVE_POORTEN.includes(n)) return `${naam} ${n} is een live poort`;
  if (ook.includes(n)) return `${naam} ${n} wordt al door een live dienst gebruikt`;
  return null;
}

function takFout(tak: string): string | null {
  if (tak.startsWith("-")) return "tak begint met -";
  if (tak === "main" || tak === "master" || tak.endsWith("/main") || tak.endsWith("/master")) return "main en master gaan nooit weg";
  if (/\.\.|\/\/|@\{|\.lock(\/|$)|[./]$|\/\./.test(tak) || tak.startsWith("/") || tak.startsWith(".")) return "tak is geen geldige refnaam";
  if (/[*?[\\^~: ]/.test(tak)) return "tak bevat een verboden teken";
  return null;
}

const takWeg: Soort = {
  id: "tak-weg",
  risico: "midden",
  zwaar: false,
  params: { tak: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/ },
  argv: (p) => ["bash", "scripts/lead/push.sh", "--verwijder", p.tak!],
  cwd: (_p, ctx) => ctx.kloon,
  env: vasteEnv,
  wat: (p) => `Verwijder de gemergede remote tak ${p.tak} van GitHub`,
  uitvoer: "toon",
  maxPerDag: 30,
  timeoutMs: 60_000,
  extraCheck: (p) => takFout(p.tak!),
  uitArgv: (a) => (a.length === 4 && a[0] === "bash" && a[1] === "scripts/lead/push.sh" && a[2] === "--verwijder" ? { tak: a[3]! } : null),
};

const tailnetOpen: Soort = {
  id: "tailnet-open",
  risico: "midden",
  zwaar: false,
  params: { https: POORT, app: POORT },
  argv: (p) => [TAILSCALE, "serve", "--bg", `--https=${p.https}`, `http://127.0.0.1:${p.app}`],
  cwd: () => "/",
  env: vasteEnv,
  wat: (p) => `Zet lokale poort ${p.app} open op de tailnet (https-poort ${p.https}), alleen voor Brians apparaten`,
  uitvoer: "toon",
  maxPerDag: 10,
  timeoutMs: 30_000,
  extraCheck: (p) => httpsFout(p.https!) ?? poortFout("app-poort", p.app!),
  uitArgv: (a) => {
    const m = /^--https=(\d+)$/.exec(a[3] ?? "");
    const u = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(a[4] ?? "");
    return a.length === 5 && a[0] === TAILSCALE && a[1] === "serve" && a[2] === "--bg" && m && u ? { https: m[1]!, app: u[1]! } : null;
  },
};

const tailnetDicht: Soort = {
  id: "tailnet-dicht",
  risico: "laag",
  zwaar: false,
  params: { https: POORT },
  argv: (p) => [TAILSCALE, "serve", `--https=${p.https}`, "off"],
  cwd: () => "/",
  env: vasteEnv,
  wat: (p) => `Zet de tailnet-regel op https-poort ${p.https} weer dicht`,
  uitvoer: "toon",
  maxPerDag: 10,
  timeoutMs: 30_000,
  extraCheck: (p) => httpsFout(p.https!),
  uitArgv: (a) => {
    const m = /^--https=(\d+)$/.exec(a[2] ?? "");
    return a.length === 4 && a[0] === TAILSCALE && a[1] === "serve" && a[3] === "off" && m ? { https: m[1]! } : null;
  },
};

const proefEcho: Soort = {
  id: "proef-echo",
  risico: "laag",
  zwaar: false,
  params: { tekst: /^[A-Za-z0-9 ]{1,40}$/ },
  argv: (p) => ["/bin/echo", p.tekst!],
  cwd: () => "/",
  env: vasteEnv,
  wat: (p) => `Proef: echo "${p.tekst}"`,
  uitvoer: "toon",
  maxPerDag: 100,
  timeoutMs: 10_000,
  alleenTest: true,
  uitArgv: (a) => (a.length === 2 && a[0] === "/bin/echo" ? { tekst: a[1]! } : null),
};

const ALLE: readonly Soort[] = [takWeg, tailnetOpen, tailnetDicht, proefEcho];

export function soorten(ctx: Pick<Ctx, "test">): readonly Soort[] {
  return ALLE.filter((s) => !s.alleenTest || ctx.test);
}

export function soort(id: string, ctx: Pick<Ctx, "test">): Soort | undefined {
  return soorten(ctx).find((s) => s.id === id);
}

/** Mag deze soort nu? Zware soorten niet in het stiltevenster (05:00–07:15). Geeft de reden of null. Voor server en runner. */
export function stilteReden(s: Soort, ctx: Pick<Ctx, "test">, nu: Date = new Date()): string | null {
  if (!soort(s.id, ctx)) return `onbekende soort: ${s.id}`;
  return s.zwaar && inStiltevenster(nu) ? "stiltevenster 05:00–07:15: geen zware runs" : null;
}

/** Zelfde, op soort-id. Een onbekende soort geeft een reden, nooit null. */
export function stilteVoor(soortId: string, ctx: Pick<Ctx, "test">, nu: Date = new Date()): string | null {
  const s = soort(soortId, ctx);
  return s ? stilteReden(s, ctx, nu) : `onbekende soort: ${soortId}`;
}

/** De soort waarvan de sjabloon dit argv precies maakt, met de params; anders null. */
export function herken(argv: string[], ctx: Ctx): { soort: string; params: Record<string, string> } | null {
  for (const s of soorten(ctx)) {
    const p = s.uitArgv?.(argv);
    if (!p) continue;
    const namen = Object.keys(s.params);
    if (Object.keys(p).length !== namen.length || !namen.every((k) => p[k] !== undefined && s.params[k]!.test(p[k]!))) continue;
    if (s.extraCheck?.(p)) continue;
    const a = s.argv(p);
    if (a.length === argv.length && a.every((x, i) => x === argv[i])) return { soort: s.id, params: p };
  }
  return null;
}
