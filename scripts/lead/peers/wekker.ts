// De wekkers van de peerbus (spoor C): per host één seintje zonder inhoud, nooit andere tekst dan seintje(n).
// Routes: Claude-TUI via de inbox-socket, Codex-TUI via `codex queue`, T3 via `t3 thread send`, acp nog niet.
// Feiten per route: ~/vault-b-status/peerbus/spike.md (sectie 1 en 4) en scripts/lead/README.md (`--t3`).

import { readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Omgeving } from "../hooks/register";
import { seintje, type WekDoel, type Wekker, type WekUitslag } from "./types";

export type RunUitslag = { code: number | null; stdout: string; stderr: string; timeout?: boolean };
/** Draait een commando; gooit niet bij een exitcode ≠ 0 maar wel (of geeft `timeout`) als het niet start of te lang duurt. */
export type Run = (cmd: string, args: string[], opties: { env: Omgeving; timeoutMs: number }) => Promise<RunUitslag>;
/** Schrijft één regel naar een unix-socket en sluit; gooit bij een fout of na `timeoutMs`. */
export type SocketSchrijf = (pad: string, regel: string, timeoutMs: number) => Promise<void>;

export const SOCKET_TIJDSGRENS_MS = 2_000;
export const CODEX_TIJDSGRENS_MS = 5_000;
export const T3_TIJDSGRENS_MS = 10_000;

export const echteRun: Run = async (cmd, args, { env, timeoutMs }) => {
  const p = Bun.spawn([cmd, ...args], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    p.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr, timeout };
  } finally {
    clearTimeout(timer);
  }
};

export const echteSocketSchrijf: SocketSchrijf = (pad, regel, timeoutMs) =>
  new Promise<void>((klaar, faal) => {
    const s = createConnection(pad);
    const timer = setTimeout(() => {
      s.destroy();
      faal(new Error("socket: tijdsgrens"));
    }, timeoutMs);
    s.once("error", (e) => {
      clearTimeout(timer);
      s.destroy();
      faal(e);
    });
    s.once("connect", () => {
      // end() wacht op de flush van de regel; pas dan is hij aangeboden aan de ontvanger
      s.end(regel, () => {
        clearTimeout(timer);
        klaar();
      });
    });
  });

/** De t3-binary zoals spawn.sh hem vindt: LAB_T3, anders `t3` op PATH, anders de nieuwste versie onder ~/.t3/runtime/versions. */
export function vindT3(env: Omgeving): string | null {
  if (env.LAB_T3) return env.LAB_T3;
  for (const d of (env.PATH ?? "").split(":")) {
    if (!d) continue;
    const p = join(d, "t3");
    if (Bun.file(p).size > 0) return p;
  }
  if (!env.HOME) return null;
  const basis = join(env.HOME, ".t3", "runtime", "versions");
  try {
    const versies = readdirSync(basis).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versies.reverse()) {
      const p = join(basis, v, "t3");
      if (Bun.file(p).size > 0) return p;
    }
  } catch {}
  return null;
}

const mislukt = (route: string, melding: string): WekUitslag => ({ gewekt: false, route, melding });

export function maakWekker(opties: { env: Omgeving; run?: Run; socketSchrijf?: SocketSchrijf; nu?: () => number }): Wekker {
  const { env } = opties;
  const run = opties.run ?? echteRun;
  const socketSchrijf = opties.socketSchrijf ?? echteSocketSchrijf;

  async function viaSocket(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    if (!doel.socket) return mislukt("socket", "geen socket in het register");
    const regel = `${JSON.stringify({ type: "user", message: { role: "user", content: seintje(aantal) } })}\n`;
    await socketSchrijf(doel.socket, regel, SOCKET_TIJDSGRENS_MS);
    return { gewekt: true, route: "socket" };
  }

  async function viaCodexQueue(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    if (!doel.thread_id) return mislukt("codex-queue", "geen thread_id in het register");
    const cenv: Omgeving = { ...env };
    if (doel.codex_home) cenv.CODEX_HOME = doel.codex_home;
    const r = await run("codex", ["queue", "--thread", doel.thread_id, "--message", seintje(aantal)], { env: cenv, timeoutMs: CODEX_TIJDSGRENS_MS });
    if (r.timeout) return mislukt("codex-queue", "codex queue: tijdsgrens");
    if (r.code !== 0) return mislukt("codex-queue", `codex queue: exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return { gewekt: true, route: "codex-queue" };
  }

  async function viaT3(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    if (!doel.t3_thread) return mislukt("t3", "geen t3_thread in het register");
    const bin = vindT3(env);
    if (!bin) return mislukt("t3", "t3-binary niet gevonden");
    const toon = await run(bin, ["thread", "show", doel.t3_thread, "--json"], { env, timeoutMs: T3_TIJDSGRENS_MS });
    if (toon.timeout) return mislukt("t3", "t3 thread show: tijdsgrens");
    if (toon.code !== 0) return mislukt("t3", `t3 thread show: exit ${toon.code}`);
    let open: unknown;
    try {
      open = (JSON.parse(toon.stdout) as { pendingRequestCount?: unknown }).pendingRequestCount;
    } catch {
      return mislukt("t3", "t3 thread show: uitvoer is geen JSON");
    }
    // Sturen naar een thread met een open vraag laat die vastlopen (T3 #15517); onbekend telt als open.
    if (open !== 0) return mislukt("t3", open === undefined ? "pendingRequestCount ontbreekt; niet gewekt" : "thread heeft een open vraag; niet gewekt");
    const r = await run(bin, ["thread", "send", doel.t3_thread, seintje(aantal)], { env, timeoutMs: T3_TIJDSGRENS_MS });
    if (r.timeout) return mislukt("t3", "t3 thread send: tijdsgrens");
    if (r.code !== 0) return mislukt("t3", `t3 thread send: exit ${r.code}`);
    return { gewekt: true, route: "t3" };
  }

  return {
    async wek(doel, aantal) {
      try {
        if (doel.host === "acp") return mislukt("acp", "niet in fase 1");
        if (doel.host === "t3") return await viaT3(doel, aantal);
        if (doel.host === "tui") {
          if (doel.vendor === "claude") return await viaSocket(doel, aantal);
          if (doel.vendor === "codex") return await viaCodexQueue(doel, aantal);
        }
        return mislukt("geen", `geen wekroute voor ${doel.vendor}/${doel.host}`);
      } catch (e) {
        return mislukt("fout", e instanceof Error ? e.message : String(e));
      }
    },
  };
}
