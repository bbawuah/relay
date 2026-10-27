// Codex-kant van de lead-hooks: de invoer van Codex is bijna gelijk aan die van Claude (fixtures/codex-*.json), dus
// hook.ts verwerkt beide. Dit bestand bevat alleen wat verschilt: de velden die het register erbij krijgt (PeerVelden),
// het toolnaam-verschil en de herkomst.
//
// Verschillen met Claude (spike 27 okt, Codex 0.164.0): geen agent_id; shelltool heet `Bash`; bestanden wijzigen is
// `apply_patch` (tool_input.command = patchtekst); PostToolUse heeft tool_response als string; MCP-tools heten
// `mcp__<server>__<tool>` (ook bij Claude). Geen SendMessage: het rapport aan de lead is `mcp__peers__send`.

import type { Herkomst, Host, PeerVelden } from "../peers/types";
import type { Omgeving } from "./register";

export type Bron = "claude" | "codex";

export const PEERS_SEND = "mcp__peers__send";

/**
 * Is een peers.send gelukt? De server antwoordt `afgeleverd <id>`, `dubbel <id>` (al eerder afgeleverd) of `vastgehouden <id>`
 * (nog niet in de inbox), en bij een fout met isError en "niet verstuurd (reden): melding". Alleen een mislukte of vastgehouden
 * send telt niet als rapport. `tool_response` is bij Codex een string, bij Claude een object ({content:[{text}], isError});
 * de MCP-vorm bij Codex is niet gemeten. Ontbreekt de response of herkennen we de vorm niet, dan telt de send: de gate mag
 * een werker niet vastzetten op een onbekend formaat (hij laat na MAX_BLOKKADES toch door).
 */
export function sendAfgeleverd(response: unknown): boolean {
  if (response === undefined || response === null) return true;
  let obj: unknown = response;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      // gewone tekst
    }
  }
  if (obj && typeof obj === "object" && (obj as { isError?: unknown }).isError === true) return false;
  let tekst = "";
  if (typeof obj === "string") tekst = obj;
  else if (obj && typeof obj === "object") {
    const o = obj as { content?: unknown; text?: unknown };
    if (Array.isArray(o.content)) tekst = o.content.map((d) => (d && typeof (d as { text?: unknown }).text === "string" ? (d as { text: string }).text : "")).join("\n");
    else if (typeof o.text === "string") tekst = o.text;
  }
  const t = tekst.trim();
  if (/^(niet verstuurd|vastgehouden)\b/.test(t)) return false;
  return true;
}

/** Lees `--bron codex` uit de argumenten van hook.ts; geeft de bron en de overige argumenten. */
export function leesBron(args: string[]): { bron: Bron; rest: string[] } {
  const rest: string[] = [];
  let bron: Bron = "claude";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bron") {
      bron = args[++i] === "codex" ? "codex" : "claude";
    } else rest.push(args[i]);
  }
  return { bron, rest };
}

/** Host van de sessie: T3 als de identiteit uit een T3-thread komt (LAB_T3_THREAD), anders de TUI. */
export function hostVan(env: Omgeving): Host {
  return env.LAB_T3_THREAD ? "t3" : "tui";
}

/** Velden die SessionStart aan het record toevoegt. Een leeg veld wordt weggelaten. */
export function peerVelden(bron: Bron, env: Omgeving, sessieId: string): PeerVelden {
  const v: PeerVelden = { vendor: bron, host: hostVan(env), herkomst: "schoon" };
  if (bron === "codex") {
    v.thread_id = sessieId;
    if (env.CODEX_HOME) v.codex_home = env.CODEX_HOME;
  } else if (env.CLAUDE_CODE_MESSAGING_SOCKET) {
    v.socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  }
  if (env.LAB_T3_THREAD) v.t3_thread = env.LAB_T3_THREAD;
  return v;
}

const EXTERN_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Na deze tool las de sessie externe inhoud: WebFetch, WebSearch of een MCP-tool buiten de server `peers`. */
export function maaktExtern(tool: string): boolean {
  if (EXTERN_TOOLS.has(tool)) return true;
  const m = /^mcp__(.+?)__/.exec(tool);
  return m !== null && m[1] !== "peers";
}

export function herkomstNa(tool: string, huidig: Herkomst | undefined): Herkomst {
  return maaktExtern(tool) ? "extern" : (huidig ?? "schoon");
}
