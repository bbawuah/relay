#!/usr/bin/env bun
// Vraag Brian om een commando uit te voeren via de kaart in Terminal B (PLAN §2.6).
// Een agent vraagt een soort met parameters, geen shellregel; Brian keurt hem goed met Face ID;
// een vaste runner voert hem uit.
//
//   bun scripts/lead/vraag-brian.ts tak-weg --tak lead/x --waarom "PR #351 gemerged"   → id op stdout
//   bun scripts/lead/vraag-brian.ts --waarom "…" -- bash scripts/lead/push.sh --verwijder lead/x
//   bun scripts/lead/vraag-brian.ts soorten
//   bun scripts/lead/vraag-brian.ts lees <id> [--json]
//   bun scripts/lead/vraag-brian.ts wacht <id> [--max 30m]
//   bun scripts/lead/vraag-brian.ts trek-in <id>
//   --droog toont verzoek, hash en kaarttekst zonder iets te schrijven.
//
// Indienen vraagt LAB_AGENT_ROL; `door` = LAB_AGENT_NAAM, `lead` = LAB_LEAD_NAAM (de lead zelf: haar eigen naam).
// Map: LAB_COMMANDO, anders ~/.local/state/lab-commando. Exit: 0 ok, 2 onbekende soort of verkeerde param
// (komt in afgewezen.jsonl), 3 geweigerd door een limiet, 1 andere fout.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Akkoord, afgeleid, testStand, commandoMap, type Ctx, geldigId, herken, kloonPad, leesGewoonBestand, MAPPEN, redigeer, schrijfAtomair, soort, soorten, type Stand, stilteVoor, type Uitslag,
  valideerUitslag, valideerVerzoek, type Verzoek, verzoekHash, zorgVoorMappen,
} from "@lab-bawuah/lab-commando";

export const VERZOEK_GELDIG_S = 24 * 3600;
export const MAX_OPEN_PER_INDIENER = 5;
export const MAX_OPEN_TOTAAL = 20;

export class LimietFout extends Error {}
export class AfwijsFout extends Error {}
/** Geen of een ongeldig id: exit 2. */
export class OnbekendFout extends Error {}

export const maakCtx = (env: Record<string, string | undefined> = process.env): Ctx => ({ kloon: kloonPad(), test: testStand(env) });

const nuS = (nu: number): number => Math.floor(nu / 1000);

function leesJson<T>(pad: string): T | null {
  try {
    return JSON.parse(leesGewoonBestand(pad)) as T;
  } catch {
    return null;
  }
}

/** Gooit bij een id dat niet [a-z0-9-]{3,64} is, zodat er nooit een pad uit een ongetoetst id komt. */
function eisId(id: string): string {
  if (!geldigId(id)) throw new OnbekendFout(`ongeldig id: ${JSON.stringify(String(id).slice(0, 80))}`);
  return id;
}

export function verzoekPad(basis: string, id: string): string {
  return join(basis, MAPPEN.verzoeken, `${eisId(id)}.json`);
}

/** Het verzoek met dit id; null als het niet bestaat, niet klopt of een ander id in zich heeft dan de bestandsnaam. */
export function leesVerzoek(basis: string, id: string): Verzoek | null {
  if (!geldigId(id)) return null;
  const j = leesJson<unknown>(verzoekPad(basis, id));
  try {
    const v = j ? valideerVerzoek(j) : null;
    return v && v.id === id ? v : null;
  } catch {
    return null;
  }
}

export type StandOfOnbekend = Stand | "onbekend";

/** De stand van een verzoek. "onbekend" als er geen verzoek, akkoord of uitslag bij dit id is (of het id ongeldig is). */
export function stand(basis: string, id: string, nu: number): { stand: StandOfOnbekend; uitslag?: Uitslag } {
  if (!geldigId(id)) return { stand: "onbekend" };
  const uPad = join(basis, MAPPEN.uitslag, `${id}.json`);
  if (existsSync(uPad)) {
    try {
      const u = valideerUitslag(JSON.parse(leesGewoonBestand(uPad)), id);
      return { stand: u.stand, uitslag: u };
    } catch (e) {
      return { stand: "fout", uitslag: { versie: 1, id, stand: "fout", staart: [], reden: `ongeldige uitslag: ${(e as Error).message}`.slice(0, 500), tijd: new Date(nu).toISOString() } };
    }
  }
  if (leesJson<Akkoord>(join(basis, MAPPEN.akkoord, `${id}.json`))) return { stand: "bezig" };
  const v = leesVerzoek(basis, id);
  if (!v) return { stand: "onbekend" };
  return nuS(nu) >= v.verlooptS ? { stand: "verlopen" } : { stand: "open" };
}

export function alleVerzoeken(basis: string): Verzoek[] {
  let namen: string[] = [];
  try {
    namen = readdirSync(join(basis, MAPPEN.verzoeken));
  } catch {
    return [];
  }
  return namen.filter((n) => n.endsWith(".json")).flatMap((n) => {
    const v = leesVerzoek(basis, n.slice(0, -5));
    return v ? [v] : [];
  });
}

const MAX_AFGEWEZEN_BYTES = 1024;

/** Alle teksten in `x` door de redactie (het argv van een afgewezen verzoek kan een geheim bevatten). */
function redigeerDiep(x: unknown): unknown {
  if (typeof x === "string") return redigeer(x);
  if (Array.isArray(x)) return x.map(redigeerDiep);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [redigeer(k), redigeerDiep(v)]));
  return x;
}

/** Eén regel voor afgewezen.jsonl: geredigeerd en hooguit 1 KB (`wat` wordt dan een afgekapte tekst). */
export function afgewezenRegel(nu: number, door: string, lead: string, reden: string, wat: unknown): string {
  const kop = { t: nu, door: redigeer(door), lead: redigeer(lead), reden: redigeer(reden).slice(0, 300) };
  const regel = JSON.stringify({ ...kop, wat: redigeerDiep(wat) });
  if (Buffer.byteLength(regel) < MAX_AFGEWEZEN_BYTES) return regel;
  let w = JSON.stringify(redigeerDiep(wat));
  for (;;) {
    const r = JSON.stringify({ ...kop, wat: w });
    if (Buffer.byteLength(r) < MAX_AFGEWEZEN_BYTES || w.length === 0) return r;
    w = w.slice(0, Math.max(0, w.length - Math.max(1, Math.ceil((Buffer.byteLength(r) - MAX_AFGEWEZEN_BYTES) / 2))));
  }
}

function afwijzen(basis: string, nu: number, door: string, lead: string, reden: string, wat: unknown, droog = false): never {
  if (!droog) {
    zorgVoorMappen(basis);
    appendFileSync(join(basis, "afgewezen.jsonl"), `${afgewezenRegel(nu, door, lead, reden, wat)}\n`, { mode: 0o600 });
  }
  throw new AfwijsFout(reden);
}

export interface Indienen {
  basis: string;
  ctx: Ctx;
  nu: number;
  door: string;
  lead: string;
  waarom: string;
  soort: string;
  params: Record<string, string>;
  droog?: boolean;
}

/** Legt een verzoek neer en geeft het id; een identiek open verzoek geeft het bestaande id terug. */
export function dien(i: Indienen): { id: string; verzoek: Verzoek; hash: string; nieuw: boolean } {
  const wat = { soort: i.soort, params: i.params };
  const s = soort(i.soort, i.ctx);
  if (!s) return afwijzen(i.basis, i.nu, i.door, i.lead, `onbekende soort: ${i.soort}`, wat, i.droog);
  const maakId = () => `${s.id}-${randomBytes(3).toString("hex")}`;
  const v: Verzoek = {
    versie: 1, id: maakId(), soort: s.id, params: i.params, waarom: i.waarom, door: i.door, lead: i.lead,
    tijd: new Date(i.nu).toISOString(), verlooptS: nuS(i.nu) + VERZOEK_GELDIG_S,
  };
  let hash: string;
  try {
    valideerVerzoek(v);
    hash = verzoekHash(v, i.ctx);
  } catch (e) {
    return afwijzen(i.basis, i.nu, i.door, i.lead, (e as Error).message, wat, i.droog);
  }
  const bestaand = alleVerzoeken(i.basis);
  const open = bestaand.filter((b) => stand(i.basis, b.id, i.nu).stand === "open");
  const dubbel = open.find((b) => b.soort === v.soort && b.door === v.door && b.lead === v.lead && JSON.stringify(Object.entries(b.params).sort()) === JSON.stringify(Object.entries(v.params).sort()));
  if (dubbel) return { id: dubbel.id, verzoek: dubbel, hash: verzoekHash(dubbel, i.ctx), nieuw: false };
  if (open.filter((b) => b.door === v.door).length >= MAX_OPEN_PER_INDIENER) throw new LimietFout(`te veel: ${v.door} heeft al ${MAX_OPEN_PER_INDIENER} open verzoeken`);
  if (open.length >= MAX_OPEN_TOTAAL) throw new LimietFout(`te veel: er staan al ${MAX_OPEN_TOTAAL} verzoeken open`);
  const vandaag = bestaand.filter((b) => b.soort === v.soort && Date.parse(b.tijd) > i.nu - 24 * 3600_000).length;
  if (vandaag >= s.maxPerDag) throw new LimietFout(`te veel: ${s.id} is al ${vandaag}× gevraagd in 24 uur (max ${s.maxPerDag})`);
  if (!i.droog) {
    zorgVoorMappen(i.basis);
    schrijfAtomair(verzoekPad(i.basis, v.id), `${JSON.stringify(v, null, 2)}\n`);
  }
  return { id: v.id, verzoek: v, hash, nieuw: true };
}

/** Trekt een eigen, nog open verzoek in (schrijft een uitslag, zodat de runner het nooit uitvoert). */
export function trekIn(basis: string, id: string, door: string, nu: number): void {
  eisId(id);
  const v = leesVerzoek(basis, id);
  if (!v) throw new OnbekendFout(`onbekend verzoek: ${id}`);
  if (v.door !== door) throw new Error(`${id} is van ${v.door}, niet van ${door}`);
  const st = stand(basis, id, nu).stand;
  if (st !== "open") throw new Error(`${id} staat op ${st}; intrekken kan alleen zolang het open is`);
  const u: Uitslag = { versie: 1, id, stand: "geweigerd", staart: [], reden: `ingetrokken door ${door}`, tijd: new Date(nu).toISOString() };
  schrijfAtomair(join(basis, MAPPEN.uitslag, `${id}.json`), `${JSON.stringify(u, null, 2)}\n`);
}

const EINDSTANDEN: StandOfOnbekend[] = ["geweigerd", "klaar", "fout", "verlopen", "onbekend"];

/** Blokkeert tot er een uitslag is (of de tijd om is); een onbekend id is meteen een eindstand. `slaap` en `nu` zijn injecteerbaar voor tests. */
export async function wacht(basis: string, id: string, maxMs: number, nu: () => number = Date.now, slaap: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<{ stand: StandOfOnbekend; uitslag?: Uitslag; teLaat: boolean }> {
  const start = nu();
  for (;;) {
    const s = stand(basis, id, nu());
    if (EINDSTANDEN.includes(s.stand)) return { ...s, teLaat: false };
    if (nu() - start >= maxMs) return { ...s, teLaat: true };
    await slaap(2000);
  }
}

export function leesArgs(argv: string[]): { pos: string[]; o: Record<string, string | boolean>; na: string[] | null } {
  const i = argv.indexOf("--");
  const voor = i === -1 ? argv : argv.slice(0, i);
  const na = i === -1 ? null : argv.slice(i + 1);
  const pos: string[] = [];
  const o: Record<string, string | boolean> = {};
  for (let k = 0; k < voor.length; k++) {
    const a = voor[k]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const naam = a.slice(2);
    if (naam === "droog" || naam === "json") o[naam] = true;
    else {
      const w = voor[++k];
      if (w === undefined) throw new Error(`--${naam} mist een waarde`);
      o[naam] = w;
    }
  }
  return { pos, o, na };
}

export function duurMs(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) throw new Error(`ongeldige duur: ${s} (bv. 30m)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}

function soortenTekst(ctx: Ctx): string {
  return soorten(ctx).map((s) => `${s.id} (${s.risico}${s.zwaar ? ", zwaar" : ""}): ${s.wat(Object.fromEntries(Object.keys(s.params).map((k) => [k, `<${k}>`])))}\n` +
    Object.entries(s.params).map(([k, r]) => `    --${k}  ${r}`).join("\n")).join("\n");
}

export function uitslagTekst(id: string, s: { stand: StandOfOnbekend; uitslag?: Uitslag }): string {
  const u = s.uitslag;
  return [`${redigeer(id).slice(0, 80)}: ${s.stand}${u?.exit !== undefined ? ` (exit ${u.exit})` : ""}${u?.reden ? ` – ${redigeer(u.reden)}` : ""}`, ...(u?.staart ?? [])].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const { pos, o, na } = leesArgs(argv);
  const ctx = maakCtx();
  const basis = commandoMap();
  const nu = Date.now();
  const cmd = pos[0];
  if (cmd === "soorten") {
    console.log(soortenTekst(ctx));
    return 0;
  }
  if (cmd === "lees") {
    if (!pos[1]) throw new Error("gebruik: lees <id> [--json]");
    const s = stand(basis, pos[1], nu);
    console.log(o.json ? JSON.stringify({ id: redigeer(pos[1]).slice(0, 80), ...s }) : uitslagTekst(pos[1], s));
    return s.stand === "onbekend" ? 2 : 0;
  }
  if (cmd === "wacht") {
    if (!pos[1]) throw new Error("gebruik: wacht <id> [--max 30m]");
    const r = await wacht(basis, pos[1], duurMs(typeof o.max === "string" ? o.max : "30m"));
    console.log(uitslagTekst(pos[1], r));
    return r.stand === "onbekend" ? 2 : r.teLaat ? 1 : r.stand === "klaar" ? 0 : 1;
  }
  const rol = process.env.LAB_AGENT_ROL;
  const naam = process.env.LAB_AGENT_NAAM || process.env.LAB_LEAD_NAAM || "";
  if (!rol || !naam) throw new Error("alleen vanuit een agentsessie: LAB_AGENT_ROL en LAB_AGENT_NAAM ontbreken");
  const door = naam;
  const lead = rol === "lead" ? naam : process.env.LAB_LEAD_NAAM || "";
  if (!lead) throw new Error("LAB_LEAD_NAAM ontbreekt");
  if (cmd === "trek-in") {
    if (!pos[1]) throw new Error("gebruik: trek-in <id>");
    trekIn(basis, pos[1], door, nu);
    console.log(`${pos[1]}: ingetrokken`);
    return 0;
  }
  const waarom = typeof o.waarom === "string" ? o.waarom : "";
  if (!waarom) throw new Error("--waarom ontbreekt");
  let soortId: string;
  let params: Record<string, string>;
  if (na) {
    const h = herken(na, ctx);
    if (!h) {
      try {
        afwijzen(basis, nu, door, lead, "geen soort maakt dit argv", { argv: na }, o.droog === true);
      } catch {
        // de melding volgt hieronder
      }
      console.error(`geen soort maakt dit argv. Mogelijk:\n${soortenTekst(ctx)}`);
      return 2;
    }
    soortId = h.soort;
    params = h.params;
  } else {
    if (!cmd) throw new Error("gebruik: <soort> --<param> … --waarom …  (zie: soorten)");
    soortId = cmd;
    params = {};
    for (const [k, w] of Object.entries(o)) if (typeof w === "string" && k !== "waarom") params[k] = w;
  }
  try {
    const r = dien({ basis, ctx, nu, door, lead, waarom, soort: soortId, params, droog: o.droog === true });
    if (o.droog) {
      const s = soort(soortId, ctx)!;
      const a = afgeleid(r.verzoek, ctx);
      console.log(JSON.stringify({ verzoek: r.verzoek, hash: r.hash, kaart: s.wat(params), argv: a.argv, cwd: a.cwd, risico: s.risico, stilte: stilteVoor(soortId, ctx) }, null, 2));
    } else console.log(r.id);
    return 0;
  } catch (e) {
    if (e instanceof LimietFout) {
      console.error(e.message);
      return 3;
    }
    if (e instanceof AfwijsFout) {
      console.error(`${e.message}\n\n${soortenTekst(ctx)}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(redigeer((e as Error).message));
      process.exit(e instanceof OnbekendFout ? 2 : 1);
    },
  );
}
