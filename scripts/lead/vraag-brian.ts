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
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Akkoord, commandoMap, kloonPad, leesGewoonBestand, MAPPEN, schrijfAtomair, type Stand, type Uitslag, zorgVoorMappen } from "./commando/opslag";
import { redigeer } from "./commando/redactie";
import { afgeleid, type Ctx, valideerVerzoek, type Verzoek, verzoekHash } from "./commando/schema";
import { herken, soort, soorten } from "./commando/soorten";
import { inStiltevenster } from "../stiltevenster";

export const VERZOEK_GELDIG_S = 24 * 3600;
export const MAX_OPEN_PER_INDIENER = 5;
export const MAX_OPEN_TOTAAL = 20;

export class LimietFout extends Error {}
export class AfwijsFout extends Error {}

export const maakCtx = (env: Record<string, string | undefined> = process.env): Ctx => ({ kloon: kloonPad(), test: !env.TMUX_PWA_LIVE });

const nuS = (nu: number): number => Math.floor(nu / 1000);

/** Is dit een zware soort die nu niet mag (stiltevenster)? Geeft de reden of null. Voor server en runner. */
export function stilteReden(soortId: string, ctx: Pick<Ctx, "test">, nu: Date = new Date()): string | null {
  const s = soort(soortId, ctx);
  return s?.zwaar && inStiltevenster(nu) ? "stiltevenster 05:00–07:15: geen zware runs" : null;
}

function leesJson<T>(pad: string): T | null {
  try {
    return JSON.parse(leesGewoonBestand(pad)) as T;
  } catch {
    return null;
  }
}

export function verzoekPad(basis: string, id: string): string {
  return join(basis, MAPPEN.verzoeken, `${id}.json`);
}

export function leesVerzoek(basis: string, id: string): Verzoek | null {
  const j = leesJson<unknown>(verzoekPad(basis, id));
  try {
    return j ? valideerVerzoek(j) : null;
  } catch {
    return null;
  }
}

export function stand(basis: string, id: string, nu: number): { stand: Stand; uitslag?: Uitslag } {
  const u = leesJson<Uitslag>(join(basis, MAPPEN.uitslag, `${id}.json`));
  if (u) return { stand: u.stand, uitslag: u };
  if (leesJson<Akkoord>(join(basis, MAPPEN.akkoord, `${id}.json`))) return { stand: "bezig" };
  const v = leesVerzoek(basis, id);
  if (v && nuS(nu) >= v.verlooptS) return { stand: "verlopen" };
  return { stand: "open" };
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

function afwijzen(basis: string, nu: number, door: string, lead: string, reden: string, wat: unknown): never {
  zorgVoorMappen(basis);
  appendFileSync(join(basis, "afgewezen.jsonl"), `${JSON.stringify({ t: nu, door, lead, reden, wat })}\n`, { mode: 0o600 });
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
  if (!s) return afwijzen(i.basis, i.nu, i.door, i.lead, `onbekende soort: ${i.soort}`, wat);
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
    return afwijzen(i.basis, i.nu, i.door, i.lead, (e as Error).message, wat);
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
  const v = leesVerzoek(basis, id);
  if (!v) throw new Error(`onbekend verzoek: ${id}`);
  if (v.door !== door) throw new Error(`${id} is van ${v.door}, niet van ${door}`);
  const st = stand(basis, id, nu).stand;
  if (st !== "open") throw new Error(`${id} staat op ${st}; intrekken kan alleen zolang het open is`);
  const u: Uitslag = { versie: 1, id, stand: "geweigerd", staart: [], reden: `ingetrokken door ${door}`, tijd: new Date(nu).toISOString() };
  schrijfAtomair(join(basis, MAPPEN.uitslag, `${id}.json`), `${JSON.stringify(u, null, 2)}\n`);
}

const EINDSTANDEN: Stand[] = ["geweigerd", "klaar", "fout", "verlopen"];

/** Blokkeert tot er een uitslag is (of de tijd om is). `slaap` en `nu` zijn injecteerbaar voor tests. */
export async function wacht(basis: string, id: string, maxMs: number, nu: () => number = Date.now, slaap: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<{ stand: Stand; uitslag?: Uitslag; teLaat: boolean }> {
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

export function uitslagTekst(id: string, s: { stand: Stand; uitslag?: Uitslag }): string {
  const u = s.uitslag;
  return [`${id}: ${s.stand}${u?.exit !== undefined ? ` (exit ${u.exit})` : ""}${u?.reden ? ` – ${redigeer(u.reden)}` : ""}`, ...(u?.staart ?? [])].join("\n");
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
    console.log(o.json ? JSON.stringify({ id: pos[1], ...s }) : uitslagTekst(pos[1], s));
    return 0;
  }
  if (cmd === "wacht") {
    if (!pos[1]) throw new Error("gebruik: wacht <id> [--max 30m]");
    const r = await wacht(basis, pos[1], duurMs(typeof o.max === "string" ? o.max : "30m"));
    console.log(uitslagTekst(pos[1], r));
    return r.teLaat ? 1 : r.stand === "klaar" ? 0 : 1;
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
        afwijzen(basis, nu, door, lead, "geen soort maakt dit argv", { argv: na });
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
      console.log(JSON.stringify({ verzoek: r.verzoek, hash: r.hash, kaart: s.wat(params), argv: a.argv, cwd: a.cwd, risico: s.risico }, null, 2));
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
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
