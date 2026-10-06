#!/usr/bin/env bun
// Besluiten voor Brian (werkwijze B, T3): de lead legt een keuze voor, Brian kiest in Regie
// op de telefoon (apps/tmux/server/besluiten.ts), en de lead leest de keuze hier terug.
//
//   bun scripts/lead/besluit.ts nieuw --id <id> --titel <t> --vraag <v> \
//       --optie ja=Akkoord --optie nee="Niet doen" --voorstel ja [--passkey] [--door <lead>]
//   bun scripts/lead/besluit.ts lijst
//   bun scripts/lead/besluit.ts lees <id>
//
// Map: --map <pad>, anders TMUX_PWA_BESLUITEN, anders ~/vault-b-status/besluiten (700; bestanden 600).
// Het bestand moet het schema van de server halen (leesBesluit); anders weigert dit script.
// Een bestaand id overschrijft het nooit. Een nieuw besluit geeft binnen 30 s een melding op
// de telefoon (alleen de titel).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { geldigBesluitId, leesBesluit, type Besluit } from "../../apps/tmux/server/besluiten";

export const standaardMap = () => process.env.TMUX_PWA_BESLUITEN || path.join(homedir(), "vault-b-status/besluiten");

type Opties = Record<string, string | boolean | string[]>;

/** --naam waarde, --vlag, en herhaalde --optie; de rest positioneel. */
export function leesArgs(argv: string[]): { pos: string[]; o: Opties } {
  const pos: string[] = [];
  const o: Opties = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const naam = a.slice(2);
    if (naam === "passkey") {
      o.passkey = true;
      continue;
    }
    const w = argv[++i];
    if (w === undefined) throw new Error(`--${naam} mist een waarde`);
    if (naam === "optie") o.optie = [...((o.optie as string[]) ?? []), w];
    else o[naam] = w;
  }
  return { pos, o };
}

/** Een nieuw besluit uit de opties, getoetst aan het schema van de server. */
export function maakBesluit(o: Opties, nu = new Date()): Besluit {
  const opties = ((o.optie as string[]) ?? []).map((s) => {
    const i = s.indexOf("=");
    if (i < 1) throw new Error(`--optie "${s}": verwacht id=label`);
    return { id: s.slice(0, i), label: s.slice(i + 1) };
  });
  const b = {
    id: o.id,
    titel: o.titel,
    vraag: o.vraag,
    voorstel: o.voorstel ?? opties[0]?.id,
    opties,
    passkey: o.passkey === true,
    door: o.door ?? process.env.LAB_LEAD_NAAM ?? "lead",
    tijd: nu.toISOString(),
  };
  const geldig = leesBesluit(b);
  if (!geldig)
    throw new Error(
      "Ongeldig besluit. Eisen: --id [a-z0-9-] (3–64), --titel (≤120, één regel), --vraag (≤2000), 2–6× --optie id=label (id [a-z0-9-], label ≤80), --voorstel = een optie-id.",
    );
  return geldig;
}

export function schrijfNieuw(map: string, b: Besluit): string {
  mkdirSync(map, { recursive: true, mode: 0o700 });
  const pad = path.join(map, `${b.id}.json`);
  // wx: een bestaand besluit (of een symlink op die naam) wordt nooit overschreven.
  writeFileSync(pad, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return pad;
}

export function leesEen(map: string, id: string): Besluit | null {
  if (!geldigBesluitId(id)) return null;
  try {
    return leesBesluit(JSON.parse(readFileSync(path.join(map, `${id}.json`), "utf8")));
  } catch {
    return null;
  }
}

export function lijstRegels(map: string): string[] {
  let namen: string[] = [];
  try {
    namen = readdirSync(map).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const regels: string[] = [];
  for (const n of namen.sort()) {
    const b = leesEen(map, n.slice(0, -5));
    if (!b) regels.push(`ongeldig  ${n}`);
    else if (b.keuze) regels.push(`beslist   ${b.id}  → ${b.keuze.optie}${b.keuze.toelichting ? " (met toelichting)" : ""}  ${b.titel}`);
    else regels.push(`open      ${b.id}  ${b.titel}${b.passkey ? "  [passkey]" : ""}`);
  }
  return regels;
}

function hoofd(argv: string[]): number {
  const { pos, o } = leesArgs(argv);
  const map = typeof o.map === "string" ? o.map : standaardMap();
  const [opdracht, id] = pos;
  if (opdracht === "nieuw") {
    const b = maakBesluit(o);
    console.log(`Besluit ${b.id} staat klaar: ${schrijfNieuw(map, b)}`);
    return 0;
  }
  if (opdracht === "lijst") {
    const r = lijstRegels(map);
    console.log(r.length ? r.join("\n") : "Geen besluiten.");
    return 0;
  }
  if (opdracht === "lees" && id) {
    const b = leesEen(map, id);
    if (!b) {
      console.error(`Geen geldig besluit ${id} in ${map}.`);
      return 1;
    }
    console.log(JSON.stringify(b, null, 2));
    return 0;
  }
  console.error("Gebruik: besluit.ts nieuw --id … --titel … --vraag … --optie id=label … [--voorstel id] [--passkey] | lijst | lees <id>   [--map <pad>]");
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(hoofd(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
