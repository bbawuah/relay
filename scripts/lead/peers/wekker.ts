// De wekkers van de peerbus (spoor C): per host één seintje zonder inhoud, nooit andere tekst dan seintje(n).
// Routes: Claude-TUI via de inbox-socket, Codex-TUI via `codex queue`, T3 via `t3 thread send`, acp nog niet.
// Feiten per route: ~/vault-b-status/peerbus/spike.md (sectie 1 en 4) en scripts/lead/README.md (`--t3`).

import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import type { Omgeving } from "../hooks/register";
import { seintje, type WekDoel, type Wekker, type WekUitslag } from "./types";

export type RunUitslag = { code: number | null; stdout: string; stderr: string; timeout?: boolean };
/** Draait een commando; gooit niet bij een exitcode ≠ 0 maar wel (of geeft `timeout`) als het niet start of te lang duurt. */
export type Run = (cmd: string, args: string[], opties: { env: Omgeving; timeoutMs: number }) => Promise<RunUitslag>;
/** Schrijft één regel naar een unix-socket en sluit; gooit bij een fout of na `timeoutMs`. */
export type SocketSchrijf = (pad: string, regel: string, timeoutMs: number) => Promise<void>;

/** Na het einde van het kind wachten we hoogstens zo lang op het sluiten van de pipes. */
export const NAGRACE_MS = 100;
export const SOCKET_TIJDSGRENS_MS = 2_000;
export const CODEX_TIJDSGRENS_MS = 5_000;
/** Eén budget voor `t3 thread show` en `t3 thread send` samen. */
export const T3_BUDGET_MS = 10_000;

/**
 * Draait een commando in een eigen procesgroep. Bij de tijdsgrens gaat de hele groep eruit (SIGTERM, daarna SIGKILL) en komt
 * de aanroep meteen terug, zonder op de pipes te wachten: een kleinkind dat ze openhoudt kan de send dus niet ophouden.
 * `timeout` is alleen waar als het proces op dat moment nog liep.
 */
export const echteRun: Run = (cmd, args, { env, timeoutMs }) =>
  new Promise<RunUitslag>((klaar, faal) => {
    const p = spawn(cmd, args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let code: number | null = null;
    let exited = false;
    let gedaan = false;
    let nagraceTimer: ReturnType<typeof setTimeout> | undefined;
    const groep = (sig: NodeJS.Signals) => {
      try {
        if (p.pid) process.kill(-p.pid, sig);
      } catch {}
    };
    const einde = (timeout: boolean) => {
      if (gedaan) return;
      gedaan = true;
      clearTimeout(timer);
      clearTimeout(nagraceTimer);
      p.stdout?.destroy();
      p.stderr?.destroy();
      klaar({ code, stdout, stderr, timeout });
    };
    const timer = setTimeout(() => {
      const liep = !exited;
      groep("SIGTERM");
      setTimeout(() => groep("SIGKILL"), 200).unref();
      einde(liep);
    }, timeoutMs);
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => (stderr += d));
    p.once("error", (e) => {
      if (gedaan) return;
      gedaan = true;
      clearTimeout(timer);
      faal(e);
    });
    p.once("exit", (c) => {
      exited = true;
      code = c;
      // Het kind is klaar; een helper die de pipes openhoudt mag de aanroep niet ophouden. Hoogstens NAGRACE_MS op de laatste uitvoer wachten.
      nagraceTimer = setTimeout(() => einde(false), NAGRACE_MS);
    });
    p.once("close", () => einde(false));
  });

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

function uitvoerbaar(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** De t3-binary zoals spawn.sh hem vindt: LAB_T3, anders `t3` op PATH, anders de nieuwste versie onder ~/.t3/runtime/versions. */
export function vindT3(env: Omgeving): string | null {
  if (env.LAB_T3) return uitvoerbaar(env.LAB_T3) ? env.LAB_T3 : null;
  for (const d of (env.PATH ?? "").split(":")) {
    if (!d) continue;
    const p = join(d, "t3");
    if (uitvoerbaar(p)) return p;
  }
  if (!env.HOME) return null;
  const basis = join(env.HOME, ".t3", "runtime", "versions");
  try {
    const versies = readdirSync(basis).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versies.reverse()) {
      const p = join(basis, v, "t3");
      if (uitvoerbaar(p)) return p;
    }
  } catch {}
  return null;
}

const mislukt = (route: string, melding: string): WekUitslag => ({ gewekt: false, route, melding });

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Alleen een echte socket onder <tmp>/cc-socks/<cijfers>.sock, na realpath (geen symlink naar elders). Geeft het pad of een reden. */
export function controleerSocket(pad: string, env: Omgeving): { pad: string } | { reden: string } {
  try {
    // realpath van de map, niet van het bestand zelf (Bun faalt op een socket); lstat weigert daarna een symlink
    const echt = join(realpathSync(dirname(pad)), basename(pad));
    const mappen = ["/tmp", env.TMPDIR].filter((d): d is string => !!d).map((d) => join(realpathSync(d), "cc-socks"));
    const ok = mappen.some((m) => echt.startsWith(`${m}/`) && /^\d+\.sock$/.test(echt.slice(m.length + 1)));
    if (!ok) return { reden: "socket staat niet onder cc-socks/<pid>.sock" };
    if (!lstatSync(echt).isSocket()) return { reden: "socketpad is geen socket" };
    return { pad: echt };
  } catch (e) {
    return { reden: `socket: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Omgeving voor een kindproces: alleen wat het nodig heeft, nooit LAB_*, socketvariabelen of de CODEX_HOME van de afzender. */
function kindEnv(env: Omgeving, extra: Omgeving = {}): Omgeving {
  const uit: Omgeving = {};
  for (const k of ["PATH", "HOME", "T3CODE_HOME"]) if (env[k] !== undefined) uit[k] = env[k];
  return { ...uit, ...extra };
}


export function maakWekker(opties: { env: Omgeving; run?: Run; socketSchrijf?: SocketSchrijf; nu?: () => number }): Wekker {
  const { env } = opties;
  const run = opties.run ?? echteRun;
  const socketSchrijf = opties.socketSchrijf ?? echteSocketSchrijf;
  const nu = opties.nu ?? Date.now;

  async function viaSocket(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    if (!doel.socket) return mislukt("socket", "geen socket in het register");
    // TOCTOU: tussen lstat in controleerSocket en connect kan het pad nog wisselen. Aanvaard: /tmp/cc-socks is 0700 van de eigen gebruiker.
    const c = controleerSocket(doel.socket, env);
    if ("reden" in c) return mislukt("socket", c.reden);
    const regel = `${JSON.stringify({ type: "user", message: { role: "user", content: seintje(aantal) } })}\n`;
    await socketSchrijf(c.pad, regel, SOCKET_TIJDSGRENS_MS);
    return { gewekt: true, route: "socket" };
  }

  async function viaCodexQueue(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    if (!doel.thread_id) return mislukt("codex-queue", "geen thread_id in het register");
    if (!ID_RE.test(doel.thread_id)) return mislukt("codex-queue", "thread_id heeft een ongeldige vorm");
    const cenv = kindEnv(env, doel.codex_home ? { CODEX_HOME: doel.codex_home } : {});
    const r = await run("codex", ["queue", `--thread=${doel.thread_id}`, "--message", seintje(aantal)], { env: cenv, timeoutMs: CODEX_TIJDSGRENS_MS });
    if (r.timeout) return mislukt("codex-queue", "codex queue: tijdsgrens");
    if (r.code !== 0) return mislukt("codex-queue", `codex queue: exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return { gewekt: true, route: "codex-queue" };
  }

  async function viaT3(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    if (!doel.t3_thread) return mislukt("t3", "geen t3_thread in het register");
    if (!ID_RE.test(doel.t3_thread)) return mislukt("t3", "t3_thread heeft een ongeldige vorm");
    const bin = vindT3(env);
    if (!bin) return mislukt("t3", "t3-binary niet gevonden");
    const start = nu();
    const rest = () => T3_BUDGET_MS - (nu() - start);
    const tenv = kindEnv(env);
    const toon = await run(bin, ["thread", "show", doel.t3_thread, "--json"], { env: tenv, timeoutMs: rest() });
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
    if (rest() <= 0) return mislukt("t3", "t3: budget van 10 s op na thread show");
    const r = await run(bin, ["thread", "send", doel.t3_thread, seintje(aantal)], { env: tenv, timeoutMs: rest() });
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
