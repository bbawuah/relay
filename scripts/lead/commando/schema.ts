// Het verzoek van een agent, de afgeleide uitvoering en de hash/challenge waar het akkoord over gaat.
// Er staat geen argv, cwd of env in het verzoek: die leidt `afgeleid` uit de soort af.
import { createHash } from "node:crypto";
import { STUUR_KLASSE } from "./redactie";
import { soort } from "./soorten";

export interface Verzoek {
  versie: 1;
  id: string;
  soort: string;
  params: Record<string, string>;
  waarom: string;
  door: string;
  lead: string;
  tijd: string;
  verlooptS: number;
}

/** kloon = eigen clone van de runner; test = !TMUX_PWA_LIVE. */
export interface Ctx {
  kloon: string;
  test: boolean;
}

const SLEUTELS = ["versie", "id", "soort", "params", "waarom", "door", "lead", "tijd", "verlooptS"] as const;
const ID = /^[a-z0-9-]{3,64}$/;
const NAAM = /^[A-Za-z0-9._-]{1,100}$/;
// Geen stuurtekens (ook geen regeleinde of tab), bidi- of zero-width-tekens in welke tekst dan ook.
const VERBODEN = new RegExp(`[\\n\\t]|${STUUR_KLASSE}`);
export const MAX_WAAROM = 500;

function tekst(x: unknown, naam: string, max: number): string {
  if (typeof x !== "string") throw new Error(`${naam} is geen tekst`);
  if (x.length > max) throw new Error(`${naam} is langer dan ${max} tekens`);
  if (VERBODEN.test(x)) throw new Error(`${naam} bevat stuur- of bidi-tekens`);
  return x;
}

export function valideerVerzoek(x: unknown): Verzoek {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("verzoek is geen object");
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(SLEUTELS as readonly string[]).includes(k)) throw new Error(`onbekende sleutel: ${k}`);
  for (const k of SLEUTELS) if (!(k in o)) throw new Error(`sleutel ontbreekt: ${k}`);
  if (o.versie !== 1) throw new Error("versie moet 1 zijn");
  const id = tekst(o.id, "id", 64);
  if (!ID.test(id)) throw new Error("id moet [a-z0-9-]{3,64} zijn");
  const s = tekst(o.soort, "soort", 64);
  if (!ID.test(s)) throw new Error("soort moet [a-z0-9-]{3,64} zijn");
  if (!o.params || typeof o.params !== "object" || Array.isArray(o.params)) throw new Error("params is geen object");
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(k)) throw new Error(`ongeldige paramnaam: ${k}`);
    params[k] = tekst(v, `param ${k}`, 200);
  }
  const waarom = tekst(o.waarom, "waarom", MAX_WAAROM);
  const door = tekst(o.door, "door", 100);
  const lead = tekst(o.lead, "lead", 100);
  if (!NAAM.test(door)) throw new Error("door heeft een ongeldige naam");
  if (!NAAM.test(lead)) throw new Error("lead heeft een ongeldige naam");
  const tijd = tekst(o.tijd, "tijd", 40);
  if (Number.isNaN(Date.parse(tijd))) throw new Error("tijd is geen datum");
  if (typeof o.verlooptS !== "number" || !Number.isInteger(o.verlooptS) || o.verlooptS <= 0) throw new Error("verlooptS is geen geheel getal in seconden");
  return { versie: 1, id, soort: s, params, waarom, door, lead, tijd, verlooptS: o.verlooptS };
}

/** argv, cwd en env zoals de runner ze maakt. Gooit bij een onbekende soort of een param die niet past. */
export function afgeleid(v: Verzoek, ctx: Ctx): { argv: string[]; cwd: string; env: Record<string, string> } {
  const s = soort(v.soort, ctx);
  if (!s) throw new Error(`onbekende soort: ${v.soort}`);
  const namen = Object.keys(s.params);
  for (const k of Object.keys(v.params)) if (!namen.includes(k)) throw new Error(`onbekende param voor ${s.id}: ${k}`);
  for (const k of namen) {
    const w = v.params[k];
    if (w === undefined) throw new Error(`param ontbreekt voor ${s.id}: ${k}`);
    if (!s.params[k]!.test(w)) throw new Error(`param ${k} past niet bij ${s.id}: ${JSON.stringify(w)}`);
  }
  const fout = s.extraCheck?.(v.params);
  if (fout) throw new Error(fout);
  return { argv: s.argv(v.params), cwd: s.cwd(v.params, ctx), env: s.env(ctx) };
}

/** Canonieke JSON: objectsleutels gesorteerd, geen witruimte. */
function canoniek(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canoniek).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canoniek(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

/** Hex sha256 van de canonieke JSON van [versie,id,soort,params,argv,cwd,env,door,lead,tijd]. */
export function verzoekHash(v: Verzoek, ctx: Ctx): string {
  const { argv, cwd, env } = afgeleid(v, ctx);
  return createHash("sha256").update(canoniek([v.versie, v.id, v.soort, v.params, argv, cwd, env, v.door, v.lead, v.tijd])).digest("hex");
}

/** base64url(sha256(`commando|id|hash|nonce|verlooptS`)): wat de passkey ondertekent. */
export function challenge(id: string, hash: string, nonce: string, verlooptS: number): string {
  return createHash("sha256").update(`commando|${id}|${hash}|${nonce}|${verlooptS}`).digest("base64url");
}
