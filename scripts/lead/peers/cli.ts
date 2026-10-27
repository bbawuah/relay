#!/usr/bin/env bun
// CLI van de peerbus: dezelfde werkwoorden als de MCP-tools, dunne schil om de Bus.
//   bun scripts/lead/peers/cli.ts send <naar> <tekst|-> [--draad d] [--antwoord-op id]
//   bun scripts/lead/peers/cli.ts inbox [--niet-acken]
//   bun scripts/lead/peers/cli.ts list [--json]
//   bun scripts/lead/peers/cli.ts notify-when-idle <naam>
//   bun scripts/lead/peers/cli.ts vasthouden <naam>            toont vastgehouden berichten
//   bun scripts/lead/peers/cli.ts vrijgeven <naam> [id…]       voor Brian of de lead, niet voor de MCP
// Afzender = env LAB_AGENT_NAAM. Staatmap = env LAB_LEAD_STAAT (zoals de hooks).

import { type Omgeving, staatMap } from "../hooks/register";
import { geldigeNaam, markeerExtern } from "./bus";
import { standaardBus } from "./standaard";
import { type Bus, toon } from "./types";

export type CliUitslag = { code: number; uit: string; fout: string };

const GEBRUIK = `Gebruik: cli.ts send <naar> <tekst|-> [--draad d] [--antwoord-op id] | inbox [--niet-acken] | list [--json] | notify-when-idle <naam> | vasthouden <naam> | vrijgeven <naam> [id…]`;

/** Haalt `--vlag waarde` uit args; geeft de waarde en de overige args. */
function neemWaarde(args: string[], vlag: string): { waarde?: string; rest: string[]; fout?: string } {
  const i = args.indexOf(vlag);
  if (i < 0) return { rest: args };
  const waarde = args[i + 1];
  if (waarde === undefined || waarde.startsWith("--")) return { rest: args, fout: `${vlag} mist een waarde` };
  return { waarde, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

export async function draai(args: string[], env: Omgeving, bus: Bus, leesStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<CliUitslag> {
  const ok = (uit: string): CliUitslag => ({ code: 0, uit: uit ? `${uit}\n` : "", fout: "" });
  const mis = (fout: string): CliUitslag => ({ code: 1, uit: "", fout: `${fout}\n` });
  const [cmd, ...rest] = args;
  const ikzelf = env.LAB_AGENT_NAAM || "";
  const eisIk = () => (ikzelf ? null : mis("LAB_AGENT_NAAM ontbreekt: ik weet niet namens wie ik spreek."));
  const naamFout = (naam: string | undefined) => (geldigeNaam(naam) ? null : mis(`ongeldige naam ${JSON.stringify(naam ?? "")}: toegestaan zijn letters, cijfers, . _ - (hoogstens 100, niet beginnend met een punt).`));
  /** vasthouden en vrijgeven zijn voor Brian (geen rol) en de lead; een werker mag het niet. */
  const eisBeheer = () => (!env.LAB_AGENT_ROL || env.LAB_AGENT_ROL === "lead" ? null : mis(`${cmd} is voor Brian of de lead (LAB_AGENT_ROL is "${env.LAB_AGENT_ROL}").`));

  switch (cmd) {
    case "send": {
      const geen = eisIk();
      if (geen) return geen;
      const d = neemWaarde(rest, "--draad");
      if (d.fout) return mis(d.fout);
      const a = neemWaarde(d.rest, "--antwoord-op");
      if (a.fout) return mis(a.fout);
      const [naar, tekstArg, ...teveel] = a.rest;
      if (!naar || tekstArg === undefined || teveel.length > 0) return mis(GEBRUIK);
      const nf = naamFout(naar);
      if (nf) return nf;
      const tekst = tekstArg === "-" ? (await leesStdin()).replace(/\n$/, "") : tekstArg;
      const u = await bus.send(ikzelf, naar, tekst, { ...(d.waarde ? { draad: d.waarde } : {}), ...(a.waarde ? { antwoord_op: a.waarde } : {}) });
      if (!u.ok) return mis(`niet verstuurd (${u.reden}): ${u.melding}`);
      const wek = u.gewekt ? `, wek: ${u.gewekt.gewekt ? "ja" : "nee"} (${u.gewekt.route})` : "";
      return ok(`${u.status} ${u.id}${wek}`);
    }
    case "inbox": {
      const geen = eisIk() ?? naamFout(ikzelf);
      if (geen) return geen;
      const berichten = bus.inbox(ikzelf);
      if (berichten.length === 0) return ok("Geen berichten.");
      const uit = berichten.map(toon).join("\n\n");
      if (!rest.includes("--niet-acken")) bus.ack(ikzelf, berichten.map((e) => e.id));
      return ok(uit);
    }
    case "list": {
      const peers = bus.list();
      if (rest.includes("--json")) return ok(JSON.stringify(peers, null, 2));
      if (peers.length === 0) return ok("Niemand aanwezig.");
      return ok(peers.map((p) => `${p.naam}\t${p.vendor}/${p.host}\t${p.toestand}\tlead ${p.lead || "-"}\t${p.machine}\tongelezen ${p.ongelezen}\tvastgehouden ${p.vastgehouden}`).join("\n"));
    }
    case "notify-when-idle": {
      const geen = eisIk();
      if (geen) return geen;
      if (rest.length !== 1) return mis(GEBRUIK);
      const nf = naamFout(rest[0]);
      if (nf) return nf;
      const u = bus.notifyWhenIdle(ikzelf, rest[0]!);
      if (!u.ok) return mis(`niet geabonneerd (${u.reden}): ${u.melding}`);
      return ok(u.al_idle ? `${rest[0]} is al idle, klaar, vrij of weg: de melding staat al in je inbox.` : `Je krijgt één melding zodra ${rest[0]} idle, klaar, vrij of weg is.`);
    }
    case "vasthouden": {
      const rol = eisBeheer();
      if (rol) return rol;
      if (rest.length !== 1) return mis(GEBRUIK);
      const nf = naamFout(rest[0]);
      if (nf) return nf;
      const vast = bus.vastgehouden(rest[0]!);
      if (vast.length === 0) return ok("Niets vastgehouden.");
      // Wie externe inhoud ziet, is zelf extern (markering; spoor D wist hem bij SessionStart).
      if (ikzelf && vast.some((e) => e.herkomst === "extern")) markeerExtern(staatMap(env), ikzelf);
      return ok(vast.map(toon).join("\n\n"));
    }
    case "vrijgeven": {
      const rol = eisBeheer();
      if (rol) return rol;
      const [naam, ...ids] = rest;
      if (!naam) return mis(GEBRUIK);
      const nf = naamFout(naam);
      if (nf) return nf;
      const n = await bus.vrijgeven(naam, ids);
      return ok(`${n} bericht${n === 1 ? "" : "en"} vrijgegeven aan ${naam}.`);
    }
    default:
      return mis(GEBRUIK);
  }
}

if (import.meta.main) {
  const r = await draai(process.argv.slice(2), process.env, standaardBus(process.env));
  process.stdout.write(r.uit);
  process.stderr.write(r.fout);
  process.exit(r.code);
}
