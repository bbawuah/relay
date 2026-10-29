// De brievenbus (fase 1): envelop, beleid en opslag in bestanden onder <staat>/peers/. Contract: types.ts.
//
//   inbox/<naam>.jsonl         alle envelops voor die ontvanger (gelezen of niet; gelezen na 24 uur opgeruimd)
//   inbox/<naam>.gelezen       ids die de ontvanger bevestigd heeft (één per regel)
//   vastgehouden/<naam>.jsonl  envelops die het inbound-beleid `hold` gaf, tot iemand ze vrijgeeft
//   abonnementen/<doel>.json   wie één idle-melding wil als <doel> idle, klaar, vrij of weg wordt
//   tempo/<van>.json           tijdstippen (ms) van de laatste minuut per afzender
//   dubbel/<naar>.json         pogingen van de laatste minuut (van, hash van de tekst, id)
//   wek/<naam>.json            laatste wektijd (ms) en, als een wek nog moet volgen, `open`
//   extern/<naam>              markering: deze sessie zag externe inhoud (spoor D wist hem bij SessionStart)
//   slot/<soort>/<naam>.lock   lock (hardlink met `pid-token`), per ontvanger (post), afzender (tempo) en doel (abo)
//
// Mappen 0700, bestanden 0600. De bus leest het register (scripts/lead/hooks/register.ts) en schrijft er nooit in.
// Elke naam die een bestandsnaam wordt, moet passen op NAAM en wordt voor elk pad in kleine letters gezet (Alice en alice delen één inbox: een send naar een naam met zo'n tweeling wordt geweigerd); alles daarbuiten (ook `.` en `..`) wordt aan elke ingang geweigerd.

import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type Rec, alleRecords } from "../hooks/register";
import {
  type AbonneerUitslag,
  type Bus,
  DUBBEL_VENSTER_MS,
  type Envelop,
  type Herkomst,
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
  type WekKort,
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
  /** Wacht `ms` (voor een wek die binnen het wekvenster viel); tests injecteren dit zodat er niet echt gewacht wordt. */
  wacht?: (ms: number) => Promise<void>;
};

type Sessie = Rec & PeerVelden;

/** Gelezen berichten blijven zo lang staan: een antwoord zoekt er de hop en draad van het origineel in. */
export const RETENTIE_MS = 24 * 3600_000;
const IDLE_TOESTANDEN = new Set(["idle", "klaar", "vrij", "weg"]);
const SLOT_MAX_MS = 5_000;
const SLOT_VEROUDERD_MS = 10_000;
export const KLAAR_MAX_MS = 15_000;
const NAAM = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

export const geenWekker: Wekker = { wek: async () => ({ gewekt: false, route: "geen" }) };

/** Mag deze naam een bestandsnaam worden? Nooit `.`, `..`, een pad of iets met een spatie. */
export function geldigeNaam(naam: unknown): naam is string {
  return typeof naam === "string" && NAAM.test(naam);
}

/** Zet de markering dat `naam` externe inhoud zag; de bus beschouwt die sessie daarna als `extern` tot spoor D de markering wist. */
export function markeerExtern(staat: string, naam: string): void {
  if (!geldigeNaam(naam)) return;
  const dir = join(staat, "peers", "extern");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, naam.toLowerCase()), `${Date.now()}\n`, { mode: 0o600 });
}

function slaap(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidLeeft(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

type WekAanvraag = { actie: "nu"; aantal: number; tot: number } | { actie: "wacht"; ms: number; tot: number };

/** De bus plus `klaar()`: wacht op wekken die op de achtergrond lopen (notifyWhenIdle, overname in list). Een CLI roept dit aan vóór hij stopt. */
export type BusMetKlaar = Bus & { klaar(): Promise<void> };

export function maakBus(opties: BusOpties): BusMetKlaar {
  const nu = opties.nu ?? Date.now;
  const wekker = opties.wekker ?? geenWekker;
  const machine = opties.machine ?? hostname();
  const wacht = opties.wacht ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const root = join(opties.staat, "peers");
  const pad = (map: string, naam: string, ext: string) => {
    if (!geldigeNaam(naam)) throw new Error(`ongeldige naam: ${JSON.stringify(naam)}`);
    return join(root, map, `${naam.toLowerCase()}${ext}`); // APFS kent geen hoofdletters: Alice en alice zijn één bestand
  };

  function zorgMap(map: string): void {
    mkdirSync(join(root, map), { recursive: true, mode: 0o700 });
  }

  /**
   * Ruimt een lock op als zijn pid dood is of hij ouder is dan SLOT_VEROUDERD_MS (pid-hergebruik). Rename-en en rm-en gebeurt
   * alleen op het lockbestand zelf. Geeft true als de lock weg is of verdween (dan opnieuw proberen).
   */
  function ruimStaleLock(lock: string): boolean {
    let inhoud: string;
    let leeftijd: number;
    try {
      inhoud = readFileSync(lock, "utf8");
      leeftijd = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return true; // lock verdween net
    }
    const pid = Number.parseInt(inhoud.split("-")[0] ?? "", 10);
    const dood = Number.isInteger(pid) && pid > 0 && !pidLeeft(pid);
    if (!dood && leeftijd <= SLOT_VEROUDERD_MS) return false;
    // Eerst hernoemen: maar één van de wachtenden wint. Is het intussen een andere (verse) lock, dan zetten we hem terug.
    const weg = `${lock}.dood.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(lock, weg);
    } catch {
      return true;
    }
    try {
      if (readFileSync(weg, "utf8") !== inhoud) {
        try {
          linkSync(weg, lock);
        } catch {
          // een nieuwe lock staat er al; die van ons is niet meer terug te zetten
        }
      }
    } catch {
      // onleesbaar: weg ermee
    }
    rmSync(weg, { force: true });
    return true;
  }

  /** Achtergebleven `.tmp`-bestanden (en `.dood.`-restanten) in een slotmap, ouder dan een minuut, van gecrashte processen. */
  function ruimTmp(dir: string): void {
    try {
      for (const n of readdirSync(dir)) {
        if (!n.endsWith(".tmp") && !/\.lock\.dood\./.test(n)) continue;
        try {
          if (Date.now() - statSync(join(dir, n)).mtimeMs > 60_000) rmSync(join(dir, n), { force: true });
        } catch {
          // al weg
        }
      }
    } catch {
      // geen map
    }
  }

  /**
   * Voert `f` uit met de lock `soort/naam`; wacht hoogstens SLOT_MAX_MS, daarna een fout (de send gooit nooit, dus wordt het `geweigerd`).
   * De lock is een hardlink naar een bestand met `pid-token`: een dode pid maakt hem meteen vrij en wij verwijderen in `finally`
   * alleen een lock die nog ons token bevat.
   */
  function metSlot<T>(soort: "post" | "tempo" | "abo", naam: string, f: () => T): T {
    if (!geldigeNaam(naam)) throw new Error(`ongeldige naam: ${JSON.stringify(naam)}`);
    const dir = join(root, "slot", soort);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ruimTmp(dir);
    const lock = join(dir, `${naam.toLowerCase()}.lock`);
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const mijn = join(dir, `${naam.toLowerCase()}.${token}.tmp`);
    writeFileSync(mijn, token, { mode: 0o600 });
    const begin = Date.now();
    try {
      for (;;) {
        try {
          linkSync(mijn, lock);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          if (ruimStaleLock(lock)) continue;
          if (Date.now() - begin > SLOT_MAX_MS) throw new Error(`lock ${soort}/${naam} bezet`);
          slaap(3);
        }
      }
    } finally {
      rmSync(mijn, { force: true });
    }
    try {
      return f();
    } finally {
      try {
        if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
      } catch {
        // al weg
      }
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

  // Alleen aanroepen met het slot `post/<naam>`.
  function alleEnvelops(naam: string): Envelop[] {
    return leesJsonl<Envelop>(pad("inbox", naam, ".jsonl")).filter(nepOfEcht);
  }
  function ongelezen(naam: string): Envelop[] {
    const gelezen = leesGelezen(naam);
    return alleEnvelops(naam).filter((e) => !gelezen.has(e.id));
  }
  function houdVast(naam: string): Envelop[] {
    return leesJsonl<Envelop>(pad("vastgehouden", naam, ".jsonl")).filter(nepOfEcht);
  }

  /** Historische post wordt alleen hersteld als de envelop nog aan het opslagcontract voldoet. */
  function herstelbaar(e: Envelop, naam: string): boolean {
    return e.naar === naam && geldigeNaam(e.van) && !!e.id &&
      typeof e.tekst === "string" && e.tekst.length <= MAX_TEKST &&
      typeof e.draad === "string" && !!e.draad &&
      typeof e.ts === "string" && Number.isFinite(Date.parse(e.ts)) &&
      Number.isInteger(e.hop) && e.hop > 0 && e.hop <= MAX_HOP &&
      ["bericht", "melding", "idle"].includes(e.soort) &&
      (e.herkomst === "schoon" || e.herkomst === "extern");
  }

  function nepOfEcht(r: unknown): r is Envelop {
    return !!r && typeof r === "object" && typeof (r as Envelop).id === "string";
  }

  /** Gelezen berichten ouder dan RETENTIE_MS weg, en gelezen-ids zonder envelop. */
  function ruimOp(naam: string): void {
    const gelezen = leesGelezen(naam);
    if (gelezen.size === 0) return;
    const alle = alleEnvelops(naam);
    // Een onderbroken herstel kan dezelfde envelop nog in de oude holdmap hebben.
    // Bewaar het inboxbewijs tot die kopie expliciet is afgehandeld: nooit opnieuw afleveren.
    const nogVast = new Set(houdVast(naam).map((e) => e.id));
    const blijf = alle.filter((e) => nogVast.has(e.id) || !(gelezen.has(e.id) && nu() - Date.parse(e.ts) > RETENTIE_MS));
    if (blijf.length === alle.length) return;
    schrijfJsonl(pad("inbox", naam, ".jsonl"), blijf);
    const ids = blijf.filter((e) => gelezen.has(e.id)).map((e) => e.id);
    schrijfAtomair(pad("inbox", naam, ".gelezen"), ids.map((i) => `${i}\n`).join(""));
  }

  // ---- register ----

  /** Levende sessies met een geldige naam; bij dezelfde naam telt het record met de laatste activiteit. */
  function levende(): Map<string, Sessie> {
    const uit = new Map<string, Sessie>();
    const activiteit = (r: Rec) => Math.max(r.sinds, r.laatste_tool_om ?? 0);
    for (const r of alleRecords(opties.staat)) {
      if (r.soort !== "sessie" || r.toestand === "weg" || !geldigeNaam(r.naam)) continue;
      const oud = uit.get(r.naam);
      if (!oud || activiteit(r) > activiteit(oud)) uit.set(r.naam, r as Sessie);
    }
    return uit;
  }

  /** Staat er nog een levende sessie waarvan de naam alleen in hoofdletters verschilt? Dan delen ze bestanden en is de ontvanger onduidelijk. */
  function heeftTweeling(naam: string, sessies: Map<string, Sessie>): boolean {
    const klein = naam.toLowerCase();
    for (const n of sessies.keys()) if (n !== naam && n.toLowerCase() === klein) return true;
    return false;
  }

  /** Extern als het register het zegt of als de bus de markering heeft gezet (een sessie die externe inhoud zag). */
  function isExtern(r: Sessie): boolean {
    return r.herkomst === "extern" || existsSync(pad("extern", r.naam, ""));
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

  type WekStaat = { ts?: number; open?: { tot: number; pid?: number; nu?: boolean } };

  /** Een wachter is levend zolang zijn proces leeft en het venster niet ruim voorbij is. */
  const wachterLeeft = (open: NonNullable<WekStaat["open"]>, n: number) => n < open.tot + WEK_VENSTER_MS && open.tot <= n + WEK_VENSTER_MS && (open.pid === undefined || pidLeeft(open.pid));

  /**
   * Beslist of en wanneer `naam` gewekt wordt. Alleen aanroepen met het slot `post/<naam>`.
   * Buiten het wekvenster: nu. Erbinnen: een wek aan het eind van het venster (`open` legt vast dat er een wachter is, zodat
   * een bericht nooit zonder seintje blijft); staat er al een levende wachter, dan hoeft deze niets.
   */
  function wekAanvraag(naam: string): WekAanvraag | null {
    zorgMap("wek");
    const p = pad("wek", naam, ".json");
    const st = leesJson<WekStaat>(p, {});
    const ts = st.ts ?? 0;
    const n = nu();
    // `ts` in de toekomst (klok teruggezet, corrupt bestand) telt als verouderd: wek nu in plaats van tot een uur te wachten.
    if (n - ts >= WEK_VENSTER_MS || ts > n) {
      // `open.nu`: deze wek loopt nu. Sterft het proces ervoor (de hook wordt na zijn budget afgebroken), dan ziet `list()` een open
      // wek met een dode pid en neemt hem over. Een andere zender in dit venster wacht er niet op (zie hieronder): deze wek telt
      // alleen wat nu al ongelezen is.
      schrijfAtomair(p, JSON.stringify({ ts: n, open: { tot: n, pid: process.pid, nu: true } }));
      return { actie: "nu", aantal: ongelezen(naam).length, tot: n };
    }
    if (st.open && !st.open.nu && wachterLeeft(st.open, n)) return null;
    const tot = ts + WEK_VENSTER_MS;
    schrijfAtomair(p, JSON.stringify({ ts, open: { tot, pid: process.pid } }));
    return { actie: "wacht", ms: Math.min(Math.max(tot - n, 0), WEK_VENSTER_MS), tot };
  }

  async function wek(doel: WekDoel, aantal: number): Promise<WekUitslag> {
    try {
      return await wekker.wek(doel, aantal);
    } catch (e) {
      return { gewekt: false, route: "fout", melding: e instanceof Error ? e.message : String(e) };
    }
  }

  const achtergrond = new Set<Promise<unknown>>();
  function opAchtergrond(p: Promise<unknown>): void {
    const q: Promise<unknown> = p.catch(() => {}).finally(() => achtergrond.delete(q));
    achtergrond.add(q);
  }

  const kort = (w: WekUitslag): WekKort => ({ gewekt: w.gewekt, route: w.route });

  /** Voert de aanvraag uit; bij `wacht` eerst wachten en dan alleen wekken als wij nog de wachter zijn en er nog ongelezen is. */
  async function voerWek(ontv: Sessie, a: WekAanvraag | null): Promise<WekKort | null> {
    if (!a) return null;
    let aantal = 0;
    if (a.actie === "nu") {
      aantal = a.aantal;
      if (aantal <= 0) nuKlaar(ontv.naam, a.tot);
    } else {
      await wacht(a.ms);
      aantal = metSlot("post", ontv.naam, () => {
        const p = pad("wek", ontv.naam, ".json");
        const open = leesJson<WekStaat>(p, {}).open;
        if (open?.tot !== a.tot || open.pid !== process.pid) return 0;
        schrijfAtomair(p, JSON.stringify({ ts: nu() }));
        return ongelezen(ontv.naam).length;
      });
    }
    if (aantal <= 0) return null;
    const uitslag = kort(await wek(wekDoel(ontv), aantal));
    if (a.actie === "nu") nuKlaar(ontv.naam, a.tot);
    return uitslag;
  }

  /** Een "nu"-wek is uitgevoerd (of er was niets te wekken): haal zijn `open` weg, zodat `list()` hem niet als verlaten overneemt. */
  function nuKlaar(naam: string, tot: number): void {
    metSlot("post", naam, () => {
      const p = pad("wek", naam, ".json");
      const st = leesJson<WekStaat>(p, {});
      if (st.open?.nu && st.open.tot === tot && st.open.pid === process.pid) schrijfAtomair(p, JSON.stringify({ ts: st.ts }));
    });
  }

  function leg(naam: string, e: Envelop): void {
    zorgMap("inbox");
    ruimOp(naam);
    appendFileSync(pad("inbox", naam, ".jsonl"), `${JSON.stringify(e)}\n`, { mode: 0o600 });
  }

  /** Tempo per afzender: telt elke poging, ook een die later wordt geweigerd; een poging boven de grens telt niet mee. */
  function tempoOk(van: string): boolean {
    zorgMap("tempo");
    return metSlot("tempo", van, () => {
      const p = pad("tempo", van, ".json");
      const recent = leesJson<number[]>(p, []).filter((t) => nu() - t < 60_000);
      if (recent.length >= MAX_PER_MINUUT) return false;
      recent.push(nu());
      schrijfAtomair(p, JSON.stringify(recent));
      return true;
    });
  }

  const hash = (tekst: string) => new Bun.CryptoHasher("sha256").update(tekst).digest("hex");
  type Poging = { van: string; h: string; ts: number; id: string };

  /** Dubbel: elke poging (ook een geweigerde of vastgehouden) staat DUBBEL_VENSTER_MS in het logboek van de ontvanger. Alleen aanroepen met het slot van `naar`. */
  function dubbelOf(naar: string, van: string, tekst: string, id: string): Poging | null {
    zorgMap("dubbel");
    const p = pad("dubbel", naar, ".json");
    const h = hash(tekst);
    const recent = leesJson<Poging[]>(p, []).filter((x) => nu() - x.ts < DUBBEL_VENSTER_MS);
    const bestaand = recent.find((x) => x.van === van && x.h === h);
    if (bestaand) return bestaand;
    schrijfAtomair(p, JSON.stringify([...recent, { van, h, ts: nu(), id }]));
    return null;
  }

  const fout = (reden: Extract<SendUitslag, { ok: false }>["reden"], melding: string): SendUitslag => ({ ok: false, reden, melding });

  async function stuur(van: string, naar: string, tekst: string, o: SendOpties): Promise<SendUitslag> {
    // Elke poging telt voor het tempo, ook een die hieronder om een andere reden wordt geweigerd.
    const tempoRuimte = geldigeNaam(van) ? tempoOk(van) : true;
    const sessies = levende();
    const afz = sessies.get(van);
    if (!afz) return fout("geen_afzender", `Afzender ${JSON.stringify(van)} staat niet (meer) in het register, of de naam is ongeldig (letters, cijfers, . _ -).`);
    if (heeftTweeling(van, sessies)) return fout("geen_afzender", `Afzender ${JSON.stringify(van)} is dubbelzinnig.`);
    const ontv = sessies.get(naar);
    if (!ontv) return fout("onbekend", `Ontvanger ${JSON.stringify(naar)} is niet bekend of niet meer levend; kijk met list.`);
    if (heeftTweeling(naar, sessies)) return fout("onbekend", `Ontvanger ${JSON.stringify(naar)} is dubbelzinnig: er is een levende sessie met dezelfde naam in andere hoofdletters.`);
    if (tekst.length > MAX_TEKST) return fout("te_lang", `Tekst is ${tekst.length} tekens; hoogstens ${MAX_TEKST}.`);

    const uit = metSlot("post", naar, (): { uitslag: SendUitslag; wek: WekAanvraag | null } => {
      // Draad en hop worden in de lock van de ontvanger bepaald, zodat twee gelijktijdige sends niet dezelfde hop krijgen.
      // Wat de afzender zelf heeft ontvangen lezen we zonder zijn lock (alleen lezen; een halve regel wordt overgeslagen).
      const bijOntvanger = [...alleEnvelops(naar), ...houdVast(naar)];
      const bijAfzender = van === naar ? bijOntvanger : [...leesJsonl<Envelop>(pad("inbox", van, ".jsonl")), ...leesJsonl<Envelop>(pad("vastgehouden", van, ".jsonl"))].filter(nepOfEcht);
      const orig = o.antwoord_op ? bijAfzender.find((e) => e.id === o.antwoord_op) : undefined;
      const draad = o.draad ?? orig?.draad ?? uuidv7(nu());
      const inDraad = [...bijOntvanger, ...(van === naar ? [] : bijAfzender)].filter((e) => e.draad === draad);
      const hop = Math.max(0, orig?.hop ?? 0, ...inDraad.map((e) => e.hop)) + 1;
      if (hop > MAX_HOP) return { uitslag: fout("hop", `Dit bericht zou hop ${hop} krijgen; hoogstens ${MAX_HOP}. Stop de heen-en-weer en vraag de lead.`), wek: null };
      if (!tempoRuimte) return { uitslag: fout("te_veel", `Meer dan ${MAX_PER_MINUUT} berichten in een minuut; wacht even.`), wek: null };

      const herkomst: Herkomst = isExtern(afz) || inDraad.some((e) => e.herkomst === "extern") ? "extern" : "schoon";
      const nuMs = nu();
      const id = uuidv7(nuMs);
      const eerder = dubbelOf(naar, van, tekst, id);
      if (eerder) return { uitslag: { ok: true, id: eerder.id, status: "dubbel", gewekt: null }, wek: null };

      if (ongelezen(naar).length + houdVast(naar).length >= MAX_WACHTRIJ) return { uitslag: fout("vol", `${naar} heeft al ${MAX_WACHTRIJ} ongelezen of vastgehouden berichten.`), wek: null };

      const e: Envelop = {
        id,
        van,
        naar,
        draad,
        ...(o.antwoord_op ? { antwoord_op: o.antwoord_op } : {}),
        ts: new Date(nuMs).toISOString(),
        hop,
        herkomst,
        soort: "bericht",
        tekst,
      };
      leg(naar, e);
      return { uitslag: { ok: true, id: e.id, status: "afgeleverd", gewekt: null }, wek: wekAanvraag(naar) };
    });
    if (uit.uitslag.ok) return { ...uit.uitslag, gewekt: await voerWek(ontv, uit.wek) };
    return uit.uitslag;
  }

  /** Idle-melding: buiten inbound-beleid en tempo, wel begrensd door de wachtrij. Geeft de wekaanvraag terug (nog niet uitgevoerd). */
  function meldSync(van: string, naar: string, tekst: string): { ontv: Sessie; aanvraag: WekAanvraag | null } | null {
    const ontv = levende().get(naar);
    if (!ontv) return null;
    const aanvraag = metSlot("post", naar, () => {
      if (ongelezen(naar).length + houdVast(naar).length >= MAX_WACHTRIJ) return null;
      leg(naar, { id: uuidv7(nu()), van, naar, draad: uuidv7(nu()), ts: new Date(nu()).toISOString(), hop: 1, herkomst: "schoon", soort: "idle", tekst });
      return wekAanvraag(naar);
    });
    return { ontv, aanvraag };
  }

  /** Laatste record met deze naam, ook als het `weg` is (voor een abonnement op een doel dat al klaar is). */
  function zoekRecord(naam: string): Sessie | undefined {
    const levend = levende().get(naam);
    if (levend) return levend;
    return (alleRecords(opties.staat).filter((r) => r.soort === "sessie" && r.naam === naam) as Sessie[]).sort((a, b) => b.sinds - a.sinds)[0];
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
      if (!geldigeNaam(naam) || heeftTweeling(naam, levende())) return [];
      const lijst = metSlot("post", naam, () => ongelezen(naam).slice(0, MAX_WACHTRIJ));
      // Wie externe inhoud ziet, is zelf extern, ook zonder ack (inbox --niet-acken).
      if (lijst.some((e) => e.herkomst === "extern")) markeerExtern(opties.staat, naam);
      return lijst;
    },

    ack(naam, ids) {
      if (!geldigeNaam(naam) || heeftTweeling(naam, levende())) return;
      const extern = metSlot("post", naam, () => {
        const gelezen = leesGelezen(naam);
        const bekend = new Map(alleEnvelops(naam).map((e) => [e.id, e]));
        const nieuw = [...new Set(ids)].filter((i) => bekend.has(i) && !gelezen.has(i));
        if (nieuw.length === 0) return false;
        zorgMap("inbox");
        appendFileSync(pad("inbox", naam, ".gelezen"), nieuw.map((i) => `${i}\n`).join(""), { mode: 0o600 });
        return nieuw.some((i) => bekend.get(i)!.herkomst === "extern");
      });
      if (extern) markeerExtern(opties.staat, naam);
    },

    async klaar() {
      // Harde bovengrens: een wekker die hangt mag de aanroeper (CLI, hook) niet blijven vasthouden.
      const lopend = (async () => {
        while (achtergrond.size > 0) await Promise.all([...achtergrond]);
      })();
      await Promise.race([lopend, wacht(KLAAR_MAX_MS)]);
    },

    list() {
      // Een wachter die stierf (pid dood of venster ruim voorbij) laat een wek liggen: de eerstvolgende list neemt hem over.
      for (const r of levende().values()) {
        try {
          const a = metSlot("post", r.naam, () => {
            const st = leesJson<WekStaat>(pad("wek", r.naam, ".json"), {});
            if (!st.open || wachterLeeft(st.open, nu()) || ongelezen(r.naam).length === 0) return null;
            return wekAanvraag(r.naam);
          });
          if (a) opAchtergrond(voerWek(r, a));
        } catch {
          // list moet altijd een lijst geven
        }
      }
      return [...levende().values()].map((r): Peer => {
        const tellers = metSlot("post", r.naam, () => ({ ongelezen: ongelezen(r.naam).length, vastgehouden: houdVast(r.naam).length }));
        return { naam: r.naam, vendor: r.vendor ?? "claude", host: r.host ?? "tui", toestand: r.toestand, lead: r.lead, cwd: r.cwd, machine, ...tellers };
      });
    },

    ongelezen(naam) {
      if (!geldigeNaam(naam) || heeftTweeling(naam, levende())) return 0;
      return metSlot("post", naam, () => ongelezen(naam).length);
    },

    notifyWhenIdle(abonnee, doel): AbonneerUitslag {
      if (!geldigeNaam(abonnee) || !levende().has(abonnee)) return { ok: false, reden: "geen_afzender", melding: `${JSON.stringify(abonnee)} staat niet (meer) in het register, of de naam is ongeldig.` };
      if (geldigeNaam(doel) && heeftTweeling(doel, levende())) return { ok: false, reden: "onbekend", melding: `${JSON.stringify(doel)} is dubbelzinnig: er is een levende sessie met dezelfde naam in andere hoofdletters.` };
      const d = geldigeNaam(doel) ? zoekRecord(doel) : undefined;
      if (!d) return { ok: false, reden: "onbekend", melding: `${JSON.stringify(doel)} is niet bekend of de naam is ongeldig; kijk met list.` };
      if (IDLE_TOESTANDEN.has(d.toestand)) {
        const m = meldSync(doel, abonnee, `${doel} is ${d.toestand}`);
        // Op de achtergrond: valt de wek binnen het wekvenster, dan wacht deze belofte; `klaar()` wacht erop (de CLI doet dat).
        if (m) opAchtergrond(voerWek(m.ontv, m.aanvraag));
        return { ok: true, al_idle: true };
      }
      zorgMap("abonnementen");
      metSlot("abo", doel, () => {
        const p = pad("abonnementen", doel, ".json");
        const abo = leesJson<string[]>(p, []);
        if (!abo.includes(abonnee)) schrijfAtomair(p, JSON.stringify([...abo, abonnee]));
      });
      return { ok: true, al_idle: false };
    },

    async idleGemeld(doel, toestand) {
      if (!geldigeNaam(doel) || !IDLE_TOESTANDEN.has(toestand)) return;
      zorgMap("abonnementen");
      const abo = metSlot("abo", doel, () => {
        const p = pad("abonnementen", doel, ".json");
        const lijst = leesJson<unknown[]>(p, []);
        if (lijst.length > 0) rmSync(p, { force: true });
        return lijst.filter(geldigeNaam);
      });
      // Eerst alle meldingen neerleggen (snel), dan de wekken tegelijk afwachten: de hook van het doel hangt zo hoogstens één wekwacht.
      const wekken: Promise<unknown>[] = [];
      for (const abonnee of abo) {
        try {
          const m = meldSync(doel, abonnee, `${doel} is ${toestand}`);
          if (m) wekken.push(voerWek(m.ontv, m.aanvraag).catch(() => {}));
        } catch {
          // een mislukte melding mag de hook van het doel niet breken
        }
      }
      await Promise.all(wekken);
    },

    vastgehouden(naam) {
      if (!geldigeNaam(naam) || heeftTweeling(naam, levende())) return [];
      return metSlot("post", naam, () => houdVast(naam));
    },

    async vrijgeven(naam, ids) {
      if (!geldigeNaam(naam) || heeftTweeling(naam, levende())) return 0;
      // Verplaatsen verandert ongelezen + vastgehouden niet, dus MAX_WACHTRIJ blijft gehaald.
      const uit = metSlot("post", naam, (): { n: number; wek: WekAanvraag | null } => {
        const vast = houdVast(naam);
        const kies = vast.filter((e) => herstelbaar(e, naam) && (!ids || ids.includes(e.id)));
        if (kies.length === 0) return { n: 0, wek: null };
        const bekend = new Set(alleEnvelops(naam).map((e) => e.id));
        const nieuw = kies.filter((e) => {
          if (bekend.has(e.id)) return false;
          bekend.add(e.id);
          return true;
        });
        // Eén atomaire inboxpublicatie; een crash vóór het opruimen is veilig opnieuw te proberen.
        if (nieuw.length) {
          zorgMap("inbox");
          const inboxPad = pad("inbox", naam, ".jsonl");
          const oud = existsSync(inboxPad) ? readFileSync(inboxPad, "utf8") : "";
          schrijfAtomair(inboxPad, `${oud}${oud && !oud.endsWith("\n") ? "\n" : ""}${nieuw.map((e) => `${JSON.stringify(e)}\n`).join("")}`);
        }
        const weg = new Set(kies.map((e) => e.id));
        // Onleesbare of vreemde historische regels blijven byte-voor-byte staan.
        // Herstel is geen impliciete opschoon- of migratieactie.
        const bestand = pad("vastgehouden", naam, ".jsonl");
        const rest = readFileSync(bestand, "utf8").split(/(?<=\n)/).filter((regel) => {
          try {
            const e = JSON.parse(regel);
            return !e || e.naar !== naam || !weg.has(e.id);
          } catch {
            return true;
          }
        }).join("");
        schrijfAtomair(bestand, rest);
        return { n: nieuw.length, wek: nieuw.length ? wekAanvraag(naam) : null };
      });
      const ontv = levende().get(naam);
      if (ontv) await voerWek(ontv, uit.wek);
      return uit.n;
    },
  };
}
