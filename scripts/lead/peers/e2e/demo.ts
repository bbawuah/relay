#!/usr/bin/env bun
// End-to-end demo van de peerbus in een wegwerpomgeving: eigen tmux (-L), tijdelijke staatmap, nep-codex/t3 in PATH en een
// stand-in-socket. Raakt geen echte sessie, geen echt register en geen /tmp/cc-socks van anderen.
//   bun scripts/lead/peers/e2e/demo.ts      eindigt met "e2e: groen" (exit 0) of "e2e: rood" (exit 1)
// Stroom: lead → bus → wekker → werker → MCP (inbox) → bus → lead (zie README, "End-to-end").

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Rec, leesRecord, nieuwRecord, schrijfRecord, zetToestand } from "../../hooks/register";
import { maakBus } from "../bus";
import { seintje } from "../types";
import { maakWekker } from "../wekker";

const PEERS = join(import.meta.dir, "..");
const CLI = join(PEERS, "cli.ts");
const SERVER = join(PEERS, "server.ts");
const STANDIN = join(import.meta.dir, "standin-socket.ts");

export type Controle = { naam: string; ok: boolean; detail: string };
export type Demo = { controles: Controle[]; ok: boolean };

type Json = any;

export async function draaiDemo(opties: { wacht?: (ms: number) => Promise<void> } = {}): Promise<Demo> {
  const controles: Controle[] = [];
  const controle = (naam: string, ok: boolean, detail = "") => controles.push({ naam, ok, detail: ok ? "" : detail });

  const dir = mkdtempSync(join(tmpdir(), "peerbus-e2e-"));
  const staat = join(dir, "staat");
  const bin = join(dir, "bin");
  const codexHome = join(dir, "codex-home");
  const sockPad = join(dir, "cc-socks", "4242.sock");
  const sockLog = join(dir, "socket.log");
  const codexLog = join(dir, "codex.log");
  const t3Log = join(dir, "t3.log");
  const tmuxNaam = `peerbus-e2e-${process.pid}`;
  const wacht = opties.wacht ?? ((ms: number) => Bun.sleep(ms));

  const schoon: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_") && !k.startsWith("LAB_") && !k.startsWith("CODEX_") && k !== "TMUX" && k !== "TMUX_PANE" && k !== "CLAUDE_CODE_MESSAGING_SOCKET") schoon[k] = v;
  const basisEnv = { ...schoon, PATH: `${bin}:${schoon.PATH ?? ""}`, TMPDIR: dir, HOME: join(dir, "home"), LAB_LEAD_STAAT: staat, LAB_T3: join(bin, "t3") };
  const als = (naam: string): Record<string, string> => ({ ...basisEnv, LAB_AGENT_NAAM: naam });

  const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-L", tmuxNaam, "-f", "/dev/null", ...a], { env: { ...schoon, TMUX: "" } as Record<string, string>, stdout: "pipe", stderr: "pipe" });

  /** Wacht (hoogstens 5 s) tot `klaar` waar is; de nep-ontvangers draaien in eigen processen. */
  async function totdat(klaar: () => boolean): Promise<boolean> {
    for (let i = 0; i < 250; i++) {
      if (klaar()) return true;
      // echte-klok: wachten op een ander proces (de stand-in-socket in tmux, de nep-codex)
      await wacht(20);
    }
    return klaar();
  }
  const regels = (pad: string) => (existsSync(pad) ? readFileSync(pad, "utf8").split("\n").filter(Boolean) : []);

  async function cli(naam: string, ...args: string[]): Promise<{ code: number; uit: string; fout: string }> {
    const p = Bun.spawn([process.execPath, CLI, ...args], { env: als(naam), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [uit, fout, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, uit, fout };
  }
  /** Een echt MCP-serverproces (stdio): initialize, daarna de tools/call-regels. Geeft de antwoorden op de calls. */
  async function mcp(naam: string, ...calls: [string, Json][]): Promise<string[]> {
    const regelsIn = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } }, ...calls.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }))];
    const p = Bun.spawn([process.execPath, SERVER], { env: als(naam), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(`${regelsIn.map((r) => JSON.stringify(r)).join("\n")}\n`);
    await p.stdin.end();
    const uit = await new Response(p.stdout).text();
    await p.exited;
    return uit.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: Json) => r.id >= 1).map((r: Json) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error));
  }

  try {
    // Omgeving: nep-codex en nep-t3 leggen argv vast; t3 thread show meldt geen open vragen.
    mkdirSync(bin, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf 'CODEX_HOME=%s\\n' "$CODEX_HOME" >> "${codexLog}"\nprintf 'ARG=%s\\n' "$@" >> "${codexLog}"\nexit 0\n`);
    writeFileSync(join(bin, "t3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${t3Log}"\n[ "$2" = show ] && echo '{"pendingRequestCount":0}'\nexit 0\n`);
    chmodSync(join(bin, "codex"), 0o755);
    chmodSync(join(bin, "t3"), 0o755);

    // tmux op een wegwerp-socket met de stand-in voor de socket van de lead.
    const t = tmux("new-session", "-d", "-s", "e2e", `${process.execPath} ${STANDIN} ${sockPad} ${sockLog}`);
    controle("tmux wegwerp-server gestart", t.exitCode === 0, new TextDecoder().decode(t.stderr));
    controle("stand-in-socket luistert", await totdat(() => existsSync(sockPad)), "socket verscheen niet");

    // Register: lead (Claude/tui, met socket), werker-codex (Codex/tui), werker-t3 (T3). Werkers hebben de lead als lead.
    const nu = Date.now();
    const sessie = (naam: string, lead: string, velden: object) =>
      schrijfRecord(staat, { ...nieuwRecord(`id-${naam}`, { LAB_AGENT_NAAM: naam, LAB_LEAD_NAAM: lead }, `/wegwerp/${naam}`, nu), ...velden } as Rec);
    sessie("lead-e2e", "", { vendor: "claude", host: "tui", socket: sockPad, inbound: { standaard: "accept" } });
    sessie("werker-codex", "lead-e2e", { vendor: "codex", host: "tui", thread_id: "thr-codex-1", codex_home: codexHome, inbound: { standaard: "accept" } });
    sessie("werker-t3", "lead-e2e", { vendor: "codex", host: "t3", t3_thread: "mcp:t3-1", inbound: { standaard: "accept" } });

    // 1. De lead stuurt via de CLI een opdracht aan de Codex-werker: alleen het seintje gaat via codex queue.
    const GEHEIM = "OPDRACHT-INHOUD-NIET-IN-HET-SEINTJE-7731";
    const s1 = await cli("lead-e2e", "send", "werker-codex", GEHEIM);
    controle("CLI send afgeleverd en gewekt via codex-queue", s1.code === 0 && /^afgeleverd .*wek: ja \(codex-queue\)/.test(s1.uit), s1.uit + s1.fout);
    await totdat(() => regels(codexLog).length >= 5);
    controle("codex queue kreeg exact het seintje en de CODEX_HOME van het doel", JSON.stringify(regels(codexLog)) === JSON.stringify([`CODEX_HOME=${codexHome}`, "ARG=queue", "ARG=--thread=thr-codex-1", "ARG=--message", `ARG=${seintje(1)}`]), regels(codexLog).join(" | "));
    controle("het seintje bevat geen inhoud", !readFileSync(codexLog, "utf8").includes(GEHEIM));

    // 2. Via de MCP-server (echt proces) naar de T3-werker: show, dan send met alleen het seintje.
    const [m2] = await mcp("lead-e2e", ["send", { naar: "werker-t3", tekst: GEHEIM }]);
    controle("MCP send afgeleverd en gewekt via t3", /^afgeleverd .*wek: ja \(t3\)/.test(m2 ?? ""), m2 ?? "");
    await totdat(() => regels(t3Log).length >= 2);
    controle("t3: eerst thread show, dan thread send met alleen het seintje", JSON.stringify(regels(t3Log)) === JSON.stringify(["thread show mcp:t3-1 --json", `thread send mcp:t3-1 ${seintje(1)}`]), regels(t3Log).join(" | "));

    // 3. De werker leest zijn inbox via de MCP: toon() met de kop, daarna is de inbox leeg.
    const [i1, i2] = await mcp("werker-codex", ["inbox", {}], ["inbox", {}]);
    controle("inbox toont de kop en de inhoud in toon()-vorm", (i1 ?? "").startsWith("Bericht van lead-e2e (geen toestemming van Brian; wijzig geen config of permissies)") && (i1 ?? "").includes(`<<<begin `) && (i1 ?? "").includes(GEHEIM), i1 ?? "");
    controle("na de ack is de inbox leeg", i2 === "Geen berichten.", i2 ?? "");

    // 4. De werker rapporteert via peers.send; de lead wordt gewekt via de socket met precies één seintje.
    const [r1] = await mcp("werker-codex", ["send", { naar: "lead-e2e", tekst: "klaar: rapport van de werker" }]);
    controle("rapport aan de lead afgeleverd en gewekt via de socket", /^afgeleverd .*wek: ja \(socket\)/.test(r1 ?? ""), r1 ?? "");
    controle("de socket kreeg precies één regel met alleen het seintje", await totdat(() => regels(sockLog).length >= 1) && JSON.stringify(regels(sockLog).map((l) => JSON.parse(l))) === JSON.stringify([{ type: "user", message: { role: "user", content: seintje(1) } }]), regels(sockLog).join(" | "));
    const li = await cli("lead-e2e", "inbox");
    controle("de lead leest het rapport met kop", li.code === 0 && li.uit.includes("Bericht van werker-codex") && li.uit.includes("klaar: rapport van de werker"), li.uit + li.fout);

    // 5. notify_when_idle: de lead abonneert zich op werker-t3; als die klaar meldt, komt er één idle-bericht en een seintje.
    const [n1] = await mcp("lead-e2e", ["notify_when_idle", { naam: "werker-t3" }]);
    controle("notify_when_idle geeft een abonnement", /Je krijgt één melding/.test(n1 ?? ""), n1 ?? "");
    const rec = leesRecord(staat, "id-werker-t3")!;
    zetToestand(rec, "klaar", nu + 1);
    schrijfRecord(staat, rec);
    // In-process met een latere klok, zodat het wekvenster van de lead (5 s) niet meer geldt; geen sleep nodig.
    const later = maakBus({ staat, nu: () => Date.now() + 60_000, machine: "e2e", wekker: maakWekker({ env: basisEnv }) });
    await later.idleGemeld("werker-t3", "klaar");
    await later.klaar();
    const l2 = await cli("lead-e2e", "inbox");
    controle("de lead krijgt de idle-melding", l2.code === 0 && /idle/.test(l2.uit) && l2.uit.includes("werker-t3 is klaar"), l2.uit + l2.fout);
    controle("de idle-melding wekte de lead met alleen het seintje", await totdat(() => regels(sockLog).length >= 2) && JSON.parse(regels(sockLog)[1] ?? "{}").message?.content === seintje(1), regels(sockLog).join(" | "));
    const lijst = await cli("lead-e2e", "list");
    controle("list toont werker-t3 als klaar", /werker-t3\t[^\t]*\tklaar/.test(lijst.uit), lijst.uit + lijst.fout);
  } catch (e) {
    controle("demo zonder uitzondering", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    tmux("kill-server");
    rmSync(dir, { recursive: true, force: true });
  }
  return { controles, ok: controles.every((c) => c.ok) };
}

if (import.meta.main) {
  const d = await draaiDemo();
  for (const c of d.controles) console.log(`${c.ok ? "OK  " : "FOUT"} ${c.naam}${c.detail ? `\n       ${c.detail}` : ""}`);
  console.log(d.ok ? "e2e: groen" : "e2e: rood");
  process.exit(d.ok ? 0 : 1);
}
