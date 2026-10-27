#!/usr/bin/env bun
// F2: dezelfde peerbus-stroom met een ECHTE Codex-werker (`spawn.sh --vendor codex`) tegen een nep-Responses-server.
// Alles in een wegwerpomgeving: eigen tmux (-L), tijdelijke staat, tijdelijke CODEX_HOME met hooks, een tijdelijke repo met
// worktree, een stand-in-socket als lead. Geen netwerk, geen inlog, niets in ~/.codex of ~/.claude, geen echte sessie.
//   bun scripts/lead/peers/e2e/codex-demo.ts     eindigt met "codex-e2e: groen" (exit 0) of "codex-e2e: rood" (exit 1)
// Eist `codex` (0.164.x), `tmux` en `bun` in PATH; ontbreekt er één, dan is de uitslag rood met de reden.
// Stroom: spawn → Codex start in tmux → nep-model: Bash `ls`, dan peers.send naar de lead, dan eindbericht → hooks vullen het
// register → de lead leest het rapport en de socket kreeg één seintje. Zie README "End-to-end" en F-echte-demo.md.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../../../test-integriteit";
import { gitHard } from "../../git-hard";
import { type Rec, leesRecord, nieuwRecord, schrijfRecord } from "../../hooks/register";
import { seintje } from "../types";
import type { Controle, Demo } from "./demo";
import { type Stap, startNep } from "./nep-responses";

const LEAD_DIR = join(import.meta.dir, "..", "..");
const SPAWN = join(LEAD_DIR, "spawn.sh");
const INSTALLEER = join(LEAD_DIR, "hooks", "codex-installeer.ts");
const CLI = join(import.meta.dir, "..", "cli.ts");
const STANDIN = join(import.meta.dir, "standin-socket.ts");

/** Hoeveel seconden de demo wacht op de Codex-werker (opstart, hooks, drie modelstappen). */
const WERKER_WACHT_S = 90;

/** De stappen van het nep-model: een Bash-aanroep, een rapport aan de lead, het eindbericht met de slotregel. */
export const STAPPEN: Stap[] = [
  { call: { name: "exec_command", args: { cmd: "ls" } } },
  { call: { namespace: "mcp__peers", name: "send", args: { naar: "lead-e2e", tekst: "klaar: rapport van de Codex-werker" } } },
  { tekst: "klaar\n\nvrij" },
];

/** De config.toml voor de wegwerp-CODEX_HOME: het nep-model en vertrouwen voor de worktree. */
export function codexConfig(nepUrl: string, worktree: string): string {
  return `model = "nep"\nmodel_provider = "nep"\n\n[model_providers.nep]\nname = "nep"\nbase_url = "${nepUrl}"\nwire_api = "responses"\nrequires_openai_auth = false\n\n[projects."${worktree}"]\ntrust_level = "trusted"\n`;
}

/** Een spawn-script voor tmux: opent een venster in de tmux-server van de demo (de echte staat in ~/.claude blijft ongemoeid). */
/** Verwijdert de stand-in-socket alleen als de demo hem zelf aanmaakte; een bestaand bestand van een ander blijft staan. */
export function ruimSocketOp(pad: string, eigen: boolean): boolean {
  if (!eigen) return false;
  try {
    rmSync(pad, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Het toolresultaat (output) van `callId` uit het laatste verzoek dat het bevat; voor de foutmelding als peers.send niets afleverde. */
export function uitvoerVan(verzoeken: { pad: string; body: string }[], callId: string): string {
  const b = verzoeken.filter((v) => v.pad.endsWith("/responses") && v.body.includes(callId)).at(-1)?.body ?? "";
  const i = b.lastIndexOf(`"call_id":"${callId}"`);
  return i < 0 ? "(geen toolresultaat in de verzoeken)" : b.slice(i, i + 500);
}

/** Zet `s` veilig tussen enkele aanhalingstekens voor een shell-opdrachtregel. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const SPAWN_STUB = `#!/bin/bash\n[ "$1" = window ] || exit 1\ntmux new-window -P -F '#{pane_id}' -c "$2" "$3"\n`;

export async function draaiCodexDemo(): Promise<Demo> {
  const controles: Controle[] = [];
  const controle = (naam: string, ok: boolean, detail = "") => controles.push({ naam, ok, detail: ok ? "" : detail });

  const dir = realpathSync(mkdtempSync(join(tmpdir(), "peerbus-codex-e2e-")));
  const staat = join(dir, "staat");
  const codexHome = join(dir, "codex-home");
  const repo = join(dir, "repo");
  const wd = join(dir, "wd");
  // De wekker laat alleen sockets toe onder /tmp/cc-socks of $TMPDIR/cc-socks, en Codex geeft de MCP-server geen TMPDIR mee: de
  // stand-in staat dus onder /tmp/cc-socks, onder het pid van deze demo (een lopend proces dat geen sessie is, dus nooit een echte
  // socket). Alleen dit ene bestand wordt aangemaakt en weer verwijderd; de map en de sockets van anderen blijven ongemoeid.
  const sockPad = join("/tmp/cc-socks", `${process.pid}.sock`);
  const sockLog = join(dir, "socket.log");
  const spawnUit = join(dir, "spawn.uit");
  const tmuxNaam = `peerbus-codex-e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let nep: ReturnType<typeof startNep> | undefined;
  let tmuxSocket = "";
  let eigenSock = false; // pas waar na de bestaanscontrole: alleen een socket die wij aanmaken, ruimen wij op

  const schoon: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_") && !k.startsWith("LAB_") && !k.startsWith("CODEX_") && k !== "TMUX" && k !== "TMUX_PANE" && !k.startsWith("CLAUDE")) schoon[k] = v;
  const basisEnv = { ...schoon, TMPDIR: dir, LAB_LEAD_STAAT: staat, CODEX_HOME: codexHome };
  const als = (naam: string): Record<string, string> => ({ ...basisEnv, LAB_AGENT_NAAM: naam });
  const gitEnv = { ...schoneEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

  const tmux = (...a: string[]): { exitCode: number; stdout: string; stderr: string } => {
    try {
      const r = Bun.spawnSync(["tmux", "-L", tmuxNaam, "-f", "/dev/null", ...a], { env: { ...schoon, TMUX: "" } as Record<string, string>, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    } catch (e) {
      return { exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  };
  /** Processen van deze demo: alleen die waarvan de opdrachtregel onze unieke tijdelijke map noemt (de Codex-daemon van de wegwerp-CODEX_HOME). */
  const demoPids = (): number[] => {
    try {
      const p = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
      return p.stdout.toString().split("\n").filter((l) => l.includes(dir) && !l.includes(" ps ")).map((l) => Number(l.trim().split(/\s+/)[0])).filter((n) => Number.isInteger(n) && n !== process.pid);
    } catch {
      return [];
    }
  };
  let opgeruimd = false;
  const opruimen = () => {
    if (opgeruimd) return;
    opgeruimd = true;
    tmux("kill-server");
    try {
      if (tmuxSocket) rmSync(tmuxSocket, { force: true });
    } catch {}
    ruimSocketOp(sockPad, eigenSock);
    for (const pid of demoPids()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    try {
      nep?.stop();
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  // `on`, niet `once`: een tweede Ctrl-C ruimt dan ook nog op (opruimen() doet het hooguit één keer).
  const bijSignaal = (code: number) => () => {
    opruimen();
    process.exit(code);
  };
  const handlers: [string, () => void][] = [
    ["SIGINT", bijSignaal(130)],
    ["SIGTERM", bijSignaal(143)],
    ["SIGHUP", bijSignaal(129)],
    ["uncaughtException", bijSignaal(1)],
    ["unhandledRejection", bijSignaal(1)],
  ];
  for (const [sig, h] of handlers) process.on(sig, h);

  const regels = (pad: string) => (existsSync(pad) ? readFileSync(pad, "utf8").split("\n").filter(Boolean) : []);
  /** Wacht (hoogstens `s` seconden) tot `klaar` waar is. */
  async function totdat(klaar: () => boolean, s = 5): Promise<boolean> {
    for (let i = 0; i < s * 20; i++) {
      if (klaar()) return true;
      // echte-klok: wachten op een ander proces (Codex in tmux, de stand-in-socket)
      await Bun.sleep(50);
    }
    return klaar();
  }
  async function cli(naam: string, ...args: string[]): Promise<{ code: number; uit: string; fout: string }> {
    const p = Bun.spawn([process.execPath, CLI, ...args], { env: als(naam), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(9), 15_000);
    try {
      const [uit, fout] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      return { code: p.exitCode ?? -1, uit, fout };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    for (const prog of ["codex", "tmux"]) {
      const w = Bun.spawnSync(["which", prog], { stdout: "pipe", stderr: "pipe" });
      controle(`${prog} gevonden`, w.exitCode === 0, `${prog} staat niet in PATH`);
      if (w.exitCode !== 0) return { controles, ok: false, tmuxNaam };
    }
    let bestaat = true;
    try {
      lstatSync(sockPad); // lstat: ook een dode symlink telt als bestaand
    } catch {
      bestaat = false;
    }
    if (bestaat) throw new Error(`${sockPad} bestaat al: niet van ons, de demo stopt`);
    eigenSock = true; // vanaf hier is het pad van ons
    mkdirSync(staat, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(repo, { recursive: true });

    // Tijdelijke repo met een eigen (linked) worktree: spawn --vendor codex eist die.
    gitHard(repo, ["init", "-q", "-b", "main"], { env: gitEnv });
    const c = gitHard(repo, ["commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv });
    const w = gitHard(repo, ["worktree", "add", "-q", "-b", "werker", wd], { env: gitEnv });
    controle("wegwerp-repo met worktree", c.code === 0 && w.code === 0, c.fout + w.fout);
    const opdracht = join(dir, "OPDRACHT.md");
    writeFileSync(opdracht, "Doe iets kleins en meld het aan je lead.\n");
    const stub = join(dir, "spawn-stub.sh");
    writeFileSync(stub, SPAWN_STUB, { mode: 0o755 });

    // Nep-model en een CODEX_HOME met hooks (vertrouwd via codex app-server, alleen in deze tijdelijke map).
    nep = startNep(STAPPEN);
    writeFileSync(join(codexHome, "config.toml"), codexConfig(nep.url, wd));
    const inst = Bun.spawnSync([process.execPath, INSTALLEER, "--codex-home", codexHome], { env: basisEnv, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    controle("hooks geïnstalleerd in de wegwerp-CODEX_HOME", inst.exitCode === 0, inst.stdout.toString() + inst.stderr.toString());
    if (inst.exitCode !== 0) return { controles, ok: false, tmuxNaam };

    // tmux met de stand-in-socket van de lead; de lead staat in het register.
    const t = tmux("new-session", "-d", "-s", "lead", `${shellQuote(process.execPath)} ${shellQuote(STANDIN)} ${shellQuote(sockPad)} ${shellQuote(sockLog)}`);
    controle("tmux wegwerp-server gestart", t.exitCode === 0, t.stderr || "tmux startte niet");
    if (t.exitCode !== 0) return { controles, ok: false, tmuxNaam };
    tmuxSocket = tmux("display-message", "-p", "-t", "lead", "#{socket_path}").stdout.trim();
    controle("stand-in-socket luistert", await totdat(() => existsSync(sockPad)), "socket verscheen niet");
    const nu = Date.now();
    schrijfRecord(staat, { ...nieuwRecord("id-lead-e2e", { LAB_AGENT_NAAM: "lead-e2e", LAB_LEAD_NAAM: "" }, "/wegwerp/lead-e2e", nu), vendor: "claude", host: "tui", socket: sockPad, inbound: { standaard: "accept" } } as Rec);

    // spawn.sh --vendor codex, binnen de wegwerp-tmux (spawn.sh eist $TMUX).
    const cmd = `LAB_SPAWN_SCRIPT=${shellQuote(stub)} LAB_SPAWN_WACHT=${WERKER_WACHT_S} bash ${shellQuote(SPAWN)} --vendor codex --naam cx-e2e --opdracht ${shellQuote(opdracht)} --lead lead-e2e --map ${shellQuote(wd)} --model nep > ${shellQuote(spawnUit)} 2>&1; echo "exit $?" >> ${shellQuote(spawnUit)}`;
    tmux("set-environment", "-g", "CODEX_HOME", codexHome);
    tmux("set-environment", "-g", "LAB_LEAD_STAAT", staat);
    tmux("run-shell", "-b", cmd);
    const gespawnd = await totdat(() => regels(spawnUit).some((r) => r.startsWith("exit ")), WERKER_WACHT_S + 30);
    const spawnTekst = readFileSync(spawnUit, "utf8");
    controle("spawn --vendor codex geslaagd (exit 0)", gespawnd && /^exit 0$/m.test(spawnTekst), spawnTekst.slice(-600));

    // De werker voert de drie modelstappen uit; de hooks vullen het register.
    controle("het nep-model kreeg drie verzoeken (Bash, peers.send, eindbericht)", await totdat(() => nep!.verzoeken.filter((v) => v.pad.endsWith("/responses")).length >= 3, 60), `${nep.verzoeken.filter((v) => v.pad.endsWith("/responses")).length} verzoeken`);
    // Elk verzoek bevat de hele geschiedenis; het laatste verzoek met het toolresultaat is het volledigste.
    const sendUitslag = nep.verzoeken.filter((v) => v.pad.endsWith("/responses")).map((v) => /afgeleverd[^"\\]*/.exec(v.body)?.[0]).filter(Boolean).at(-1) ?? "";
    controle("peers.send van de werker meldt: afgeleverd, wek: ja (socket)", /^afgeleverd .*wek: ja \(socket\)/.test(sendUitslag), sendUitslag || uitvoerVan(nep.verzoeken, "call_2"));
    // Pas tellen als het eindbericht er is (derde verzoek) en de eerste regel binnen is; dan een korte rust voor een eventueel tweede seintje.
    const eerste = await totdat(() => regels(sockLog).length >= 1, 20);
    // echte-klok: rust na het eindbericht, een tweede seintje zou van een ander proces komen
    await Bun.sleep(1500);
    controle("de socket van de lead kreeg precies één seintje van de werker", eerste && regels(sockLog).length === 1, regels(sockLog).join(" | "));
    const li = await cli("lead-e2e", "inbox");
    controle("de lead leest het rapport van cx-e2e", li.code === 0 && li.uit.includes("Bericht van cx-e2e") && li.uit.includes("klaar: rapport van de Codex-werker"), li.uit + li.fout);
    const lijst = await cli("lead-e2e", "list");
    controle("list toont cx-e2e (codex) onder lead-e2e", /^cx-e2e\tcodex\/\S+\t.*lead lead-e2e/m.test(lijst.uit), lijst.uit + lijst.fout);
    const rec = (() => {
      try {
        for (const f of existsSync(join(staat, "register")) ? Bun.spawnSync(["ls", join(staat, "register")], { stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean) : []) {
          const r = leesRecord(staat, f.replace(/\.json$/, ""));
          if (r?.naam === "cx-e2e") return r;
        }
      } catch {}
      return undefined;
    })();
    controle("register: cx-e2e is een Codex-sessie met een laatste tool-aanroep", rec?.vendor === "codex" && rec.laatste_tool_om != null, JSON.stringify(rec ?? null).slice(0, 400));
    controle("het seintje bevat geen inhoud", regels(sockLog).every((l) => !l.includes("rapport van de Codex-werker") && l.includes(seintje(1))), regels(sockLog).join(" | "));
  } catch (e) {
    controle("demo zonder uitzondering", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    opruimen();
    for (const [sig, h] of handlers) process.off(sig, h);
  }
  return { controles, ok: controles.every((c) => c.ok), tmuxNaam };
}

if (import.meta.main) {
  const d = await draaiCodexDemo();
  for (const c of d.controles) console.log(`${c.ok ? "OK  " : "FOUT"} ${c.naam}${c.detail ? `\n       ${c.detail}` : ""}`);
  console.log(d.ok ? "codex-e2e: groen" : "codex-e2e: rood");
  process.exit(d.ok ? 0 : 1);
}
