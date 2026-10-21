#!/usr/bin/env bun
// Besluiten voor Brian (werkwijze B, T3): de lead legt een keuze voor, Brian kiest in Regie
// op de telefoon (apps/tmux/server/besluiten.ts), en de lead leest de keuze hier terug.
//
//   bun scripts/lead/besluit.ts nieuw --id <id> --titel <t> --vraag <v> \
//       --optie ja=Akkoord --optie nee="Niet doen" --voorstel ja [--passkey] [--door <lead>] \
//       [--deadline 30m|2h|<ISO>] [--zonder-antwoord nee="Dan laat ik het zoals het is."]
//   bun scripts/lead/besluit.ts lijst [--audit <pad>]
//   bun scripts/lead/besluit.ts lees <id> [--audit <pad>]
//
// Map: --map <pad>, anders TMUX_PWA_BESLUITEN, anders ~/vault-b-status/besluiten (700; bestanden 600).
// Een keuze op een besluit met passkey geldt pas als het auditlog van de tmux-server een regel
// "passkey-actie" ok heeft voor doel besluit:<id>:<optie> (de gekozen optie), van hetzelfde apparaat, kort vóór de keuze;
// anders tonen lijst en lees hem als "onbevestigd" (wie de map kan schrijven, kan geen keuze
// vervalsen die de lead voor echt aanziet). Auditlog: --audit <pad>, anders
// $TMUX_PWA_DATA/audit.jsonl, anders ~/.local/share/tmux-pwa/audit.jsonl.
// Het bestand moet het schema van de server halen (leesBesluit); anders weigert dit script.
// --deadline (hooguit 7 dagen): daarna meldt de tmux-server "verlopen" in de inbox van de lead,
// en geeft `lees` exit 4. --zonder-antwoord is wat de lead dan zelf doet (de server kiest niets);
// alleen met een deadline en zonder passkey (B5: een besluit met slot heeft geen standaard).
// Een bestaand id overschrijft het nooit. Een nieuw besluit geeft binnen 30 s een melding op
// de telefoon (alleen de titel).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { geldigBesluitId, isVerlopen, leesBesluit, type Besluit } from "../../apps/tmux/server/besluiten";

export const standaardAudit = () => path.join(process.env.TMUX_PWA_DATA || path.join(homedir(), ".local/share/tmux-pwa"), "audit.jsonl");
/** How long before the choice the passkey may have been given (the challenge lives 60 s; room for typing a note). */
export const BEVESTIG_MS = 10 * 60_000;

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

/** "30m", "2h" of een ISO-tijd → ISO; null als het geen van die vormen is. */
export function leesDeadline(s: string, nu: Date): string | null {
  const m = /^(\d{1,4})([mh])$/.exec(s);
  if (m) return new Date(nu.getTime() + Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000)).toISOString();
  const t = Date.parse(s);
  return /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(t) ? new Date(t).toISOString() : null;
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
  } as Record<string, unknown>;
  if (typeof o.deadline === "string") {
    const d = leesDeadline(o.deadline, nu);
    if (!d) throw new Error(`--deadline "${o.deadline}": verwacht 30m, 2h of een ISO-tijd`);
    b.deadline = d;
  }
  if (typeof o["zonder-antwoord"] === "string") {
    const z = o["zonder-antwoord"];
    const i = z.indexOf("=");
    if (i < 1) throw new Error(`--zonder-antwoord "${z}": verwacht optie=uitleg`);
    b.zonderAntwoord = { optie: z.slice(0, i), uitleg: z.slice(i + 1) };
  }
  const geldig = leesBesluit(b);
  if (!geldig)
    throw new Error(
      "Ongeldig besluit. Eisen: --id [a-z0-9-] (3–64), --titel (≤120, één regel), --vraag (≤2000), 2–6× --optie id=label (id [a-z0-9-], label ≤80), --voorstel = een optie-id; --deadline na nu en ≤ 7 dagen; --zonder-antwoord optie=uitleg (≤200) alleen met --deadline en zonder --passkey.",
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

/** The ok passkey-actie lines from the audit log text (unparseable lines are skipped). */
export function passkeyActies(auditTekst: string): { tijd: string; apparaat: string; doel: string }[] {
  const uit: { tijd: string; apparaat: string; doel: string }[] = [];
  for (const r of auditTekst.split("\n")) {
    if (!r.includes('"passkey-actie"')) continue;
    try {
      const j = JSON.parse(r);
      if (j.gebeurtenis === "passkey-actie" && j.ok === true && typeof j.doel === "string" && typeof j.apparaat === "string" && typeof j.tijd === "string")
        uit.push({ tijd: j.tijd, apparaat: j.apparaat, doel: j.doel });
    } catch {}
  }
  return uit;
}

/** "bevestigd" when a choice needs no passkey or the audit log holds its passkey; "onbevestigd" otherwise; null without a choice. */
export function controle(b: Besluit, acties: ReturnType<typeof passkeyActies>): "bevestigd" | "onbevestigd" | null {
  if (!b.keuze) return null;
  if (!b.passkey) return "bevestigd";
  const k = Date.parse(b.keuze.tijd);
  const ok = acties.some((a) => {
    const t = Date.parse(a.tijd);
    return a.doel === `besluit:${b.id}:${b.keuze!.optie}` && a.apparaat === b.keuze!.door && t <= k && k - t <= BEVESTIG_MS;
  });
  return ok ? "bevestigd" : "onbevestigd";
}

export function leesAudit(pad: string) {
  try {
    return passkeyActies(readFileSync(pad, "utf8"));
  } catch {
    return [];
  }
}

export function lijstRegels(map: string, acties: ReturnType<typeof passkeyActies> = [], nu = Date.now()): string[] {
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
    else if (b.keuze) {
      const c = controle(b, acties);
      regels.push(`${c === "onbevestigd" ? "ONBEVESTIGD" : "beslist  "} ${b.id}  → ${b.keuze.optie}${b.keuze.toelichting ? " (met toelichting)" : ""}  ${b.titel}${c === "onbevestigd" ? "  [geen passkey in het auditlog]" : ""}`);
    }
    else {
      const tot = b.deadline ? `  [tot ${b.deadline}${b.zonderAntwoord ? `, anders ${b.zonderAntwoord.optie}` : ""}]` : "";
      regels.push(`${isVerlopen(b, nu) ? "VERLOPEN " : "open     "} ${b.id}  ${b.titel}${b.passkey ? "  [passkey]" : ""}${tot}`);
    }
  }
  return regels;
}

function hoofd(argv: string[]): number {
  const { pos, o } = leesArgs(argv);
  const map = typeof o.map === "string" ? o.map : standaardMap();
  const audit = typeof o.audit === "string" ? o.audit : standaardAudit();
  const [opdracht, id] = pos;
  if (opdracht === "nieuw") {
    const b = maakBesluit(o);
    console.log(`Besluit ${b.id} staat klaar: ${schrijfNieuw(map, b)}`);
    return 0;
  }
  if (opdracht === "lijst") {
    const r = lijstRegels(map, leesAudit(audit));
    console.log(r.length ? r.join("\n") : "Geen besluiten.");
    return 0;
  }
  if (opdracht === "lees" && id) {
    const b = leesEen(map, id);
    if (!b) {
      console.error(`Geen geldig besluit ${id} in ${map}.`);
      return 1;
    }
    const c = controle(b, leesAudit(audit));
    console.log(JSON.stringify(c ? { ...b, controle: c } : b, null, 2));
    if (c === "onbevestigd") console.error(`Let op: ${id} vraagt een passkey, maar het auditlog (${audit}) heeft er geen voor deze keuze. Behandel de keuze als onbevestigd.`);
    if (isVerlopen(b, Date.now())) {
      console.error(`${id} is verlopen zonder antwoord. ${b.zonderAntwoord ? `Jouw standaard: ${b.zonderAntwoord.optie} (${b.zonderAntwoord.uitleg}); dat is geen keuze van Brian.` : "Geen standaard: wacht op Brian."}`);
      return 4;
    }
    return 0;
  }
  console.error("Gebruik: besluit.ts nieuw --id … --titel … --vraag … --optie id=label … [--voorstel id] [--passkey] [--deadline 30m|2h|ISO] [--zonder-antwoord optie=uitleg] | lijst | lees <id>   [--map <pad>] [--audit <pad>]");
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
