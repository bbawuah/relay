// De brievenbus (fase 1): envelop, beleid en opslag in bestanden onder <staat>/peers/. Contract: types.ts.
//
//   inbox/<naam>.jsonl         alle envelops voor die ontvanger (gelezen of niet; gelezen na 24 uur opgeruimd)
//   inbox/<naam>.gelezen       ids die de ontvanger bevestigd heeft (één per regel)
//   vastgehouden/<naam>.jsonl  envelops die het inbound-beleid `hold` gaf, tot iemand ze vrijgeeft
//   abonnementen/<doel>.json   wie één idle-melding wil als <doel> idle, klaar, vrij of weg wordt
//   tempo/<van>.json           tijdstippen (ms) van de laatste minuut per afzender
//   wek/<naam>.json            laatste wektijd (ms) per ontvanger
//   slot/<sleutel>/            lock (mkdir is atomair), per ontvanger en per afzender, nooit twee tegelijk vast
//
// Mappen 0700, bestanden 0600. De bus leest het register (scripts/lead/hooks/register.ts) maar schrijft er niet in.

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type Rec, alleRecords, veilig } from "../hooks/register";
import {
  type Bus,
  DUBBEL_VENSTER_MS,
  type Envelop,
  type Herkomst,
  type Inbound,
  MAX_HOP,
  MAX_PER_MINUUT,
  MAX_TEKST,
  MAX_WACHTRIJ,
  type Peer,
  type PeerVelden,
  type SendOpties,
  type SendUitslag,
  WEK_VENSTER_MS,
  type WekDoel,
  type WekUitslag,
  type Wekker,
} from "./types";
import { uuidv7 } from "./uuid";

export type BusOpties = {
  /** Staatmap (zoals `staatMap(env)`); de bus schrijft onder `<staat>/peers/`. */
  staat: string;
  /** Klok in ms; tests injecteren hem. */
  nu?: () => number;
  wekker?: Wekker;
  /** Naam van deze machine in `list()`. */
  machine?: string;
};

/** Wat Brian en de lead erbij krijgen (CLI), niet de MCP: vastgehouden berichten bekijken en vrijgeven. */
export interface BusBeheer extends Bus {
  vastgehouden(naam: string): Envelop[];
  /** Zet vastgehouden berichten (alle, of alleen `ids`) in de inbox en wekt de ontvanger. Geeft het aantal. */
  vrijgeven(naam: string, ids?: string[]): Promise<number>;
}

type Sessie = Rec & PeerVelden;

/** Gelezen berichten blijven zo lang staan: een antwoord zoekt er de hop en draad van het origineel in. */
export const RETENTIE_MS = 24 * 3600_000;
const IDLE_TOESTANDEN = new Set(["idle", "klaar", "vrij", "weg"]);
const SLOT_MAX_MS = 5_000;
const SLOT_VEROUDERD_MS = 10_000;

export const geenWekker: Wekker = { wek: async () => ({ gewekt: false, route: "geen" }) };

function slaap(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function maakBus(opties: BusOpties): BusBeheer {
  const nu = opties.nu ?? Date.now;
  const wekker = opties.wekker ?? geenWekker;
  const machine = opties.machine ?? hostname();
  const root = join(opties.staat, "peers");
  const pad = (map: string, naam: string, ext: string) => join(root, map, `${veilig(naam)}${ext}`);

  function zorgMap(map: string): void {
    mkdirSync(join(root, map), { recursive: true, mode: 0o700 });
  }

  /** Voert `f` uit met een lock; wacht hoogstens SLOT_MAX_MS, daarna een fout (de send gooit nooit, dus wordt het `geweigerd`). */
  function metSlot<T>(sleutel: string, f: () => T): T {
    zorgMap("slot");
    const slot = join(root, "slot", veilig(sleutel));
    const begin = Date.now();
    for (;;) {
      try {
        mkdirSync(slot, { mode: 0o700 });
        break;
      } catch {
        try {
          if (Date.now() - statSync(slot).mtimeMs > SLOT_VEROUDERD_MS) {
            // Eerst hernoemen: maar één van de wachtenden wint, die ruimt de dode lock op.
            const weg = `${slot}.dood.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
            renameSync(slot, weg);
            rmSync(weg, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // lock verdween net: opnieuw proberen
        }
        if (Date.now() - begin > SLOT_MAX_MS) throw new Error(`lock ${sleutel} bezet`);
        slaap(3);
      }
    }
    try {
      return f();
    } finally {
      rmSync(slot, { recursive: true, force: true });
    }
  }

  function leesJsonl<T>(p: string): T[] {
    let tekst: string;
    try {
      tekst = readFileSync(p, "utf8");
    } catch {
      return [];
    }
    const uit: T[] = [];
    for (const l of tekst.split("\n")) {
      if (!l.trim()) continue;
      try {
        uit.push(JSON.parse(l) as T);
      } catch {
        // kapotte regel overslaan
      }
    }
    return uit;
  }

  function schrijfAtomair(p: string, inhoud: string): void {
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, inhoud, { mode: 0o600 });
    renameSync(tmp, p);
  }

  function schrijfJsonl(p: string, regels: unknown[]): void {
    schrijfAtomair(p, regels.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }

  function leesJson<T>(p: string, leeg: T): T {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return leeg;
    }
  }

  function leesGelezen(naam: string): Set<string> {
    try {
      return new Set(readFileSync(pad("inbox", naam, ".gelezen"), "utf8").split("\n").filter(Boolean));
    } catch {
      return new Set();
    }
  }

  // Alleen aanroepen met het slot van `naam`.
  function alleEnvelops(naam: string): Envelop[] {
    return leesJsonl<Envelop>(pad("inbox", naam, ".jsonl"));
  }
  function ongelezen(naam: string): Envelop[] {
    const gelezen = leesGelezen(naam);
    return alleEnvelops(naam).filter((e) => !gelezen.has(e.id));
  }
  function houdVast(naam: string): Envelop[] {
    return leesJsonl<Envelop>(pad("vastgehouden", naam, ".jsonl"));
  }

  /** Gelezen berichten ouder dan RETENTIE_MS weg, en gelezen-ids zonder envelop. */
  function ruimOp(naam: string): void {
    const gelezen = leesGelezen(naam);
    if (gelezen.size === 0) return;
    const alle = alleEnvelops(naam);
    const blijf = alle.filter((e) => !(gelezen.has(e.id) && nu() - Date.parse(e.ts) > RETENTIE_MS));
    if (blijf.length === alle.length) return;
    schrijfJsonl(pad("inbox", naam, ".jsonl"), blijf);
    const ids = blijf.filter((e) => gelezen.has(e.id)).map((e) => e.id);
    schrijfAtomair(pad("inbox", naam, ".gelezen"), ids.map((i) => `${i}\n`).join(""));
  }

  // ---- register ----

  /** Levende sessies; bij dezelfde naam telt het record met de laatste activiteit. */
  function levende(): Map<string, Sessie> {
    const uit = new Map<string, Sessie>();
    const activiteit = (r: Rec) => Math.max(r.sinds, r.laatste_tool_om ?? 0);
    for (const r of alleRecords(opties.staat)) {
      if (r.soort !== "sessie" || r.toestand === "weg" || !r.naam) continue;
      const oud = uit.get(r.naam);
      if (!oud || activiteit(r) > activiteit(oud)) uit.set(r.naam, r as Sessie);
    }
    return uit;
  }

  function beleid(ontv: Sessie, afz: Sessie): Inbound {
    const eigen = ontv.inbound?.per_afzender?.[afz.naam];
    if (eigen) return eigen;
    if (ontv.inbound?.standaard) return ontv.inbound.standaard;
    return ontv.lead === afz.naam || afz.lead === ontv.naam ? "accept" : "hold";
  }

  function wekDoel(r: Sessie): WekDoel {
    return {
      naam: r.naam,
      vendor: r.vendor ?? "claude",
      host: r.host ?? "tui",
      toestand: r.toestand,
      ...(r.thread_id ? { thread_id: r.thread_id } : {}),
      ...(r.codex_home ? { codex_home: r.codex_home } : {}),
      ...(r.t3_thread ? { t3_thread: r.t3_thread } : {}),
      ...(r.socket ? { socket: r.socket } : {}),
    };
  }

  /** Wekt `doel` als het wekvenster dat toelaat. Alleen aanroepen met het slot van de ontvanger; geeft het aantal terug of null. */
  function wekPlan(naam: string): number | null {
    const p = pad("wek", naam, ".json");
    const vorige = leesJson<{ ts?: number }>(p, {}).ts ?? 0;
    if (nu() - vorige < WEK_VENSTER_MS) return null;
    zorgMap("wek");
    schrijfAtomair(p, JSON.stringify({ ts: nu() }));
    return ongelezen(naam).length;
  }

  async function wek(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    try {
      return await wekker.wek(doel, aantal);
    } catch (e) {
      return { gewekt: false, route: "fout", melding: e instanceof Error ? e.message : String(e) };
    }
  }

  function leg(naam: string, e: Envelop): void {
    zorgMap("inbox");
    ruimOp(naam);
    appendFileSync(pad("inbox", naam, ".jsonl"), `${JSON.stringify(e)}\n`, { mode: 0o600 });
  }

  function nepOfEcht(r: unknown): r is Envelop {
    return !!r && typeof r === "object" && typeof (r as Envelop).id === "string";
  }

  /** Zoekt een bericht dat `naam` ontving of vasthoudt (voor hop en draad van een antwoord). */
  function zoekOntvangen(naam: string, id: string): Envelop | null {
    return metSlot(naam, () => [...alleEnvelops(naam), ...houdVast(naam)].find((e) => nepOfEcht(e) && e.id === id) ?? null);
  }

  /** Tempo per afzender: telt elke poging die de lock haalt, ook als een latere regel het bericht weigert. */
  function tempoOk(van: string): boolean {
    zorgMap("tempo");
    return metSlot(`tempo-${van}`, () => {
      const p = pad("tempo", van, ".json");
      const recent = leesJson<number[]>(p, []).filter((t) => nu() - t < 60_000);
      if (recent.length >= MAX_PER_MINUUT) return false;
      recent.push(nu());
      schrijfAtomair(p, JSON.stringify(recent));
      return true;
    });
  }

  const fout = (reden: Extract<SendUitslag, { ok: false }>["reden"], melding: string): SendUitslag => ({ ok: false, reden, melding });

  async function stuur(van: string, naar: string, tekst: string, o: SendOpties): Promise<SendUitslag> {
    const sessies = levende();
    const afz = sessies.get(van);
    if (!afz) return fout("geen_afzender", `Afzender ${van} staat niet (meer) in het register.`);
    const ontv = sessies.get(naar);
    if (!ontv) return fout("onbekend", `Ontvanger ${naar} is niet bekend of niet meer levend; kijk met list.`);
    if (tekst.length > MAX_TEKST) return fout("te_lang", `Tekst is ${tekst.length} tekens; hoogstens ${MAX_TEKST}.`);

    const origineel = o.antwoord_op ? zoekOntvangen(van, o.antwoord_op) : null;
    const hop = origineel ? origineel.hop + 1 : 1;
    if (hop > MAX_HOP) return fout("hop", `Dit antwoord zou hop ${hop} krijgen; hoogstens ${MAX_HOP}. Stop de heen-en-weer en vraag de lead.`);
    const draad = o.draad ?? origineel?.draad ?? uuidv7(nu());

    if (!tempoOk(van)) return fout("te_veel", `Meer dan ${MAX_PER_MINUUT} berichten in een minuut; wacht even.`);

    const herkomst: Herkomst = afz.herkomst ?? "schoon";
    const uit = metSlot(naar, (): { uitslag: SendUitslag; aantal: number | null } => {
      const nuMs = nu();
      const bestaand = [...alleEnvelops(naar), ...houdVast(naar)].find((e) => e.van === van && e.tekst === tekst && nuMs - Date.parse(e.ts) < DUBBEL_VENSTER_MS);
      if (bestaand) return { uitslag: { ok: true, id: bestaand.id, status: "dubbel", gewekt: null }, aantal: null };

      const regel = beleid(ontv, afz);
      if (regel === "refuse") return { uitslag: fout("geweigerd", `${naar} weigert berichten van ${van}.`), aantal: null };
      const vasthouden = regel === "hold";
      if ((vasthouden ? houdVast(naar).length : ongelezen(naar).length) >= MAX_WACHTRIJ) return { uitslag: fout("vol", `${naar} heeft al ${MAX_WACHTRIJ} ${vasthouden ? "vastgehouden" : "ongelezen"} berichten.`), aantal: null };

      const e: Envelop = {
        id: uuidv7(nuMs),
        van,
        naar,
        draad,
        ...(o.antwoord_op ? { antwoord_op: o.antwoord_op } : {}),
        ts: new Date(nuMs).toISOString(),
        hop,
        herkomst,
        soort: o.soort ?? "bericht",
        tekst,
      };
      if (vasthouden) {
        zorgMap("vastgehouden");
        appendFileSync(pad("vastgehouden", naar, ".jsonl"), `${JSON.stringify(e)}\n`, { mode: 0o600 });
        return { uitslag: { ok: true, id: e.id, status: "vastgehouden", gewekt: null }, aantal: null };
      }
      leg(naar, e);
      return { uitslag: { ok: true, id: e.id, status: "afgeleverd", gewekt: null }, aantal: wekPlan(naar) };
    });
    if (uit.aantal !== null && uit.uitslag.ok) return { ...uit.uitslag, gewekt: await wek(wekDoel(ontv), uit.aantal) };
    return uit.uitslag;
  }

  /** Systeembericht (idle-melding): buiten het beleid, wel begrensd door de wachtrij. */
  async function meld(van: string, naar: string, tekst: string): Promise<void> {
    const ontv = levende().get(naar);
    const aantal = metSlot(naar, () => {
      if (ongelezen(naar).length >= MAX_WACHTRIJ) return null;
      leg(naar, { id: uuidv7(nu()), van, naar, draad: uuidv7(nu()), ts: new Date(nu()).toISOString(), hop: 1, herkomst: "schoon", soort: "idle", tekst });
      return wekPlan(naar);
    });
    if (aantal !== null && ontv) await wek(wekDoel(ontv), aantal);
  }

  return {
    async send(van, naar, tekst, o = {}) {
      try {
        return await stuur(van, naar, tekst, o);
      } catch (e) {
        return fout("geweigerd", `Versturen mislukte: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    inbox(naam) {
      return metSlot(naam, () => ongelezen(naam).slice(0, MAX_WACHTRIJ));
    },

    ack(naam, ids) {
      metSlot(naam, () => {
        const gelezen = leesGelezen(naam);
        const bekend = new Set(alleEnvelops(naam).map((e) => e.id));
        const nieuw = [...new Set(ids)].filter((i) => bekend.has(i) && !gelezen.has(i));
        if (nieuw.length === 0) return;
        zorgMap("inbox");
        appendFileSync(pad("inbox", naam, ".gelezen"), nieuw.map((i) => `${i}\n`).join(""), { mode: 0o600 });
      });
    },

    list() {
      return [...levende().values()].map(
        (r): Peer => ({ naam: r.naam, vendor: r.vendor ?? "claude", host: r.host ?? "tui", toestand: r.toestand, lead: r.lead, cwd: r.cwd, machine }),
      );
    },

    notifyWhenIdle(abonnee, doel) {
      zorgMap("abonnementen");
      metSlot(`abo-${doel}`, () => {
        const p = pad("abonnementen", doel, ".json");
        const abo = leesJson<string[]>(p, []);
        if (!abo.includes(abonnee)) schrijfAtomair(p, JSON.stringify([...abo, abonnee]));
      });
    },

    async idleGemeld(doel, toestand) {
      if (!IDLE_TOESTANDEN.has(toestand)) return;
      zorgMap("abonnementen");
      const abo = metSlot(`abo-${doel}`, () => {
        const p = pad("abonnementen", doel, ".json");
        const lijst = leesJson<string[]>(p, []);
        if (lijst.length > 0) rmSync(p, { force: true });
        return lijst;
      });
      for (const abonnee of abo) {
        try {
          await meld(doel, abonnee, `${doel} is ${toestand}.`);
        } catch {
          // een mislukte melding mag de hook van het doel niet breken
        }
      }
    },

    vastgehouden(naam) {
      return metSlot(naam, () => houdVast(naam));
    },

    async vrijgeven(naam, ids) {
      const aantal = metSlot(naam, (): { n: number; wek: number | null } => {
        const vast = houdVast(naam);
        const kies = vast.filter((e) => !ids || ids.length === 0 || ids.includes(e.id));
        const ruimte = Math.max(0, MAX_WACHTRIJ - ongelezen(naam).length);
        const over = kies.slice(0, ruimte);
        if (over.length === 0) return { n: 0, wek: null };
        for (const e of over) leg(naam, e);
        const weg = new Set(over.map((e) => e.id));
        schrijfJsonl(pad("vastgehouden", naam, ".jsonl"), vast.filter((e) => !weg.has(e.id)));
        return { n: over.length, wek: wekPlan(naam) };
      });
      const ontv = levende().get(naam);
      if (aantal.wek !== null && ontv) await wek(wekDoel(ontv), aantal.wek);
      return aantal.n;
    },
  };
}
