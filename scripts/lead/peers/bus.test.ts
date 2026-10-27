import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Rec, alleRecords, nieuwRecord, schrijfRecord } from "../hooks/register";
import { RETENTIE_MS, geldigeNaam, maakBus } from "./bus";
import { DUBBEL_VENSTER_MS, MAX_HOP, MAX_PER_MINUUT, MAX_TEKST, MAX_WACHTRIJ, type PeerVelden, WEK_VENSTER_MS, type WekDoel, type WekUitslag, type Wekker } from "./types";

// Alles draait in een wegwerpmap (tijdelijke staatmap); het echte register in ~/.local/state/lab-lead blijft ongemoeid.

const T0 = 1_700_000_000_000;

let dir: string;
let staat: string;
let klok: number;
let wekken: { doel: WekDoel; aantal: number }[];
let wekAntwoord: () => Promise<WekUitslag>;

const nepWekker: Wekker = {
  wek: (doel, aantal) => {
    wekken.push({ doel, aantal });
    return wekAntwoord();
  },
};
/** `wacht` zet de nep-klok vooruit: er wordt in de tests nooit echt gewacht. */
const maak = () => maakBus({ staat, nu: () => klok, wekker: nepWekker, machine: "testmachine", wacht: async (ms) => void (klok += ms) });

/** Schrijft een register-record; `lead` en `extra` (PeerVelden, toestand, ...) zijn optioneel. */
function sessie(naam: string, lead = "", extra: Partial<Rec> & PeerVelden = {}): void {
  const r = { ...nieuwRecord(`id-${naam}-${Object.keys(extra).length}-${extra.sinds ?? 0}`, { LAB_AGENT_NAAM: naam, LAB_LEAD_NAAM: lead }, `/w/${naam}`, klok), ...extra };
  schrijfRecord(staat, r as Rec);
}
const open = (...namen: string[]) => namen.forEach((n) => sessie(n, "", { inbound: { standaard: "accept" } }));

/** Alle bestanden onder slot/ (de map zelf mag er zijn). */
function slotBestanden(): string[] {
  const uit: string[] = [];
  const loop = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d, { withFileTypes: true })) (n.isDirectory() ? loop(join(d, n.name)) : uit.push(join(d, n.name)));
  };
  loop(join(staat, "peers/slot"));
  return uit;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-peers-"));
  staat = join(dir, "staat");
  klok = T0;
  wekken = [];
  wekAntwoord = async () => ({ gewekt: true, route: "nep" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("send: beleid in volgorde", () => {
  test("onbekende afzender: geen_afzender (ook een afzender met toestand weg)", async () => {
    open("b");
    sessie("a", "", { toestand: "weg" });
    for (const van of ["niemand", "a"]) {
      const u = await maak().send(van, "b", "hoi");
      expect(u).toMatchObject({ ok: false, reden: "geen_afzender" });
    }
  });

  test("ontvanger onbekend of weg: onbekend", async () => {
    open("a");
    sessie("w", "", { toestand: "weg" });
    expect(await maak().send("a", "niemand", "hoi")).toMatchObject({ ok: false, reden: "onbekend" });
    expect(await maak().send("a", "w", "hoi")).toMatchObject({ ok: false, reden: "onbekend" });
  });

  test("te lang: precies MAX_TEKST mag, één meer niet", async () => {
    open("a", "b");
    expect(await maak().send("a", "b", "x".repeat(MAX_TEKST))).toMatchObject({ ok: true });
    expect(await maak().send("a", "b", "x".repeat(MAX_TEKST + 1))).toMatchObject({ ok: false, reden: "te_lang" });
  });

  test("geen_afzender gaat voor onbekend, onbekend voor te_lang", async () => {
    open("b");
    expect(await maak().send("x", "niemand", "y".repeat(MAX_TEKST + 1))).toMatchObject({ reden: "geen_afzender" });
    open("a");
    expect(await maak().send("a", "niemand", "y".repeat(MAX_TEKST + 1))).toMatchObject({ reden: "onbekend" });
  });

  test("hop: een nieuw bericht is hop 1, een antwoord +1, boven MAX_HOP geweigerd, en de draad blijft", async () => {
    open("a", "b");
    const bus = maak();
    const eerste = await bus.send("a", "b", "vraag 0");
    expect(eerste.ok).toBe(true);
    let laatste = bus.inbox("b")[0]!;
    expect(laatste.hop).toBe(1);
    const draad = laatste.draad;
    let wie: [string, string] = ["b", "a"];
    for (let h = 2; h <= MAX_HOP; h++) {
      klok += 10;
      const u = await bus.send(wie[0], wie[1], `antwoord ${h}`, { antwoord_op: laatste.id });
      expect(u.ok).toBe(true);
      laatste = bus.inbox(wie[1]).find((e) => e.tekst === `antwoord ${h}`)!;
      expect(laatste.hop).toBe(h);
      expect(laatste.draad).toBe(draad);
      expect(laatste.antwoord_op).toBeDefined();
      wie = [wie[1], wie[0]];
    }
    const te = await bus.send(wie[0], wie[1], "nog één", { antwoord_op: laatste.id });
    expect(te).toMatchObject({ ok: false, reden: "hop" });
  });

  test("antwoord_op met een onbekend id: hop 1", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "x", { antwoord_op: "bestaat-niet" });
    expect(bus.inbox("b")[0]!.hop).toBe(1);
  });

  test("een meegegeven draad wordt gebruikt, anders een nieuwe uuid", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "een", { draad: "mijn-draad" });
    await bus.send("a", "b", "twee");
    const [e1, e2] = bus.inbox("b");
    expect(e1!.draad).toBe("mijn-draad");
    expect(e2!.draad).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("tempo: MAX_PER_MINUUT per afzender, glijdend venster, andere afzender onbelemmerd", async () => {
    open("a", "b", "c");
    const bus = maakBus({ staat, nu: () => klok, wekker: nepWekker, wacht: async () => {} }); // wachten telt hier niet mee in de nep-klok
    for (let i = 0; i < MAX_PER_MINUUT; i++) {
      klok += 100;
      expect(await bus.send("a", "b", `bericht ${i}`)).toMatchObject({ ok: true });
    }
    expect(await bus.send("a", "b", "te veel")).toMatchObject({ ok: false, reden: "te_veel" });
    expect(await bus.send("c", "b", "ik niet")).toMatchObject({ ok: true });
    klok += 60_000;
    expect(await bus.send("a", "b", "weer ruimte")).toMatchObject({ ok: true });
  });

  test("dubbel binnen het venster: ok, zelfde id, niet opnieuw opgeslagen of gewekt; daarna weer gewoon", async () => {
    open("a", "b");
    const bus = maak();
    const eerste = await bus.send("a", "b", "zelfde");
    expect(wekken).toHaveLength(1);
    klok += DUBBEL_VENSTER_MS - 1;
    const tweede = await bus.send("a", "b", "zelfde");
    expect(tweede).toMatchObject({ ok: true, status: "dubbel", gewekt: null });
    expect(tweede.ok && eerste.ok && tweede.id === eerste.id).toBe(true);
    expect(bus.inbox("b")).toHaveLength(1);
    expect(wekken).toHaveLength(1);
    klok += 1;
    expect(await bus.send("a", "b", "zelfde")).toMatchObject({ ok: true, status: "afgeleverd" });
    expect(bus.inbox("b")).toHaveLength(2);
  });

  test("dubbel telt per van, naar en tekst", async () => {
    open("a", "b", "c");
    const bus = maak();
    await bus.send("a", "b", "x");
    expect(await bus.send("c", "b", "x")).toMatchObject({ status: "afgeleverd" });
    expect(await bus.send("a", "c", "x")).toMatchObject({ status: "afgeleverd" });
    expect(await bus.send("a", "b", "y")).toMatchObject({ status: "afgeleverd" });
  });

  test("inbound refuse: geweigerd, niets opgeslagen", async () => {
    open("a");
    sessie("b", "", { inbound: { standaard: "accept", per_afzender: { a: "refuse" } } });
    const bus = maak();
    expect(await bus.send("a", "b", "hoi")).toMatchObject({ ok: false, reden: "geweigerd" });
    expect(bus.inbox("b")).toEqual([]);
    expect(bus.vastgehouden("b")).toEqual([]);
  });

  test("inbound hold: status vastgehouden, niet in de inbox, niet gewekt; vrijgeven zet hem in de inbox en wekt", async () => {
    open("a");
    sessie("b", "", { inbound: { standaard: "hold" } });
    const bus = maak();
    const u = await bus.send("a", "b", "wacht maar");
    expect(u).toMatchObject({ ok: true, status: "vastgehouden", gewekt: null });
    expect(wekken).toHaveLength(0);
    expect(bus.inbox("b")).toEqual([]);
    expect(bus.vastgehouden("b").map((e) => e.tekst)).toEqual(["wacht maar"]);
    expect(await bus.vrijgeven("b")).toBe(1);
    expect(bus.vastgehouden("b")).toEqual([]);
    expect(bus.inbox("b").map((e) => e.tekst)).toEqual(["wacht maar"]);
    expect(wekken).toHaveLength(1);
  });

  test("vrijgeven met ids haalt alleen die eruit; een onbekend id geeft 0", async () => {
    open("a");
    sessie("b", "", { inbound: { standaard: "hold" } });
    const bus = maak();
    await bus.send("a", "b", "een");
    await bus.send("a", "b", "twee");
    const [e1, e2] = bus.vastgehouden("b");
    expect(await bus.vrijgeven("b", ["nep"])).toBe(0);
    expect(await bus.vrijgeven("b", [e2!.id])).toBe(1);
    expect(bus.inbox("b").map((e) => e.tekst)).toEqual(["twee"]);
    expect(bus.vastgehouden("b").map((e) => e.id)).toEqual([e1!.id]);
  });

  test("inbound standaard zonder beleid: accept van de eigen lead en van eigen werkers, anders hold", async () => {
    sessie("lead", "");
    sessie("werker", "lead");
    sessie("vreemd", "andere-lead");
    const bus = maak();
    expect(await bus.send("lead", "werker", "opdracht")).toMatchObject({ status: "afgeleverd" }); // ontvanger.lead === van
    expect(await bus.send("werker", "lead", "rapport")).toMatchObject({ status: "afgeleverd" }); // afzender.lead === naar
    expect(await bus.send("vreemd", "werker", "hoi")).toMatchObject({ status: "vastgehouden" });
    expect(await bus.send("vreemd", "lead", "hoi")).toMatchObject({ status: "vastgehouden" });
    sessie("collega", "lead");
    expect(await bus.send("collega", "werker", "hoi")).toMatchObject({ status: "vastgehouden" }); // zelfde lead is geen eigen lead
  });

  test("per_afzender gaat voor standaard, in beide richtingen", async () => {
    open("a", "c");
    sessie("b", "", { inbound: { standaard: "accept", per_afzender: { a: "hold" } } });
    sessie("d", "", { inbound: { standaard: "hold", per_afzender: { c: "accept" } } });
    const bus = maak();
    expect(await bus.send("a", "b", "x")).toMatchObject({ status: "vastgehouden" });
    expect(await bus.send("c", "b", "x")).toMatchObject({ status: "afgeleverd" });
    expect(await bus.send("c", "d", "x")).toMatchObject({ status: "afgeleverd" });
    expect(await bus.send("a", "d", "x")).toMatchObject({ status: "vastgehouden" });
  });

  test("wachtrij vol: MAX_WACHTRIJ ongelezen, daarna vol; na ack weer ruimte", async () => {
    const afz = Array.from({ length: 5 }, (_, i) => `s${i}`);
    open("b", ...afz);
    const bus = maak();
    for (let i = 0; i < MAX_WACHTRIJ; i++) {
      klok += 10;
      expect(await bus.send(afz[i % 5]!, "b", `m${i}`)).toMatchObject({ ok: true });
    }
    expect(await bus.send("s0", "b", "een te veel")).toMatchObject({ ok: false, reden: "vol" });
    const eerste = bus.inbox("b")[0]!;
    bus.ack("b", [eerste.id]);
    expect(await bus.send("s0", "b", "nu wel")).toMatchObject({ ok: true });
  });

  test("vol telt ook voor vastgehouden berichten", async () => {
    const afz = Array.from({ length: 5 }, (_, i) => `s${i}`);
    open(...afz);
    sessie("b", "", { inbound: { standaard: "hold" } });
    const bus = maak();
    for (let i = 0; i < MAX_WACHTRIJ; i++) {
      klok += 10;
      expect(await bus.send(afz[i % 5]!, "b", `m${i}`)).toMatchObject({ status: "vastgehouden" });
    }
    expect(await bus.send("s0", "b", "te veel")).toMatchObject({ ok: false, reden: "vol" });
  });

  test("volgorde: refuse gaat voor vol; dubbel gaat voor refuse", async () => {
    open("a");
    sessie("b", "", { inbound: { standaard: "accept" } });
    const bus = maak();
    await bus.send("a", "b", "zelfde");
    sessie("b", "", { inbound: { standaard: "refuse" }, sinds: klok + 1 });
    expect(await bus.send("a", "b", "zelfde")).toMatchObject({ ok: true, status: "dubbel" });
    expect(await bus.send("a", "b", "anders")).toMatchObject({ ok: false, reden: "geweigerd" });
  });
});

describe("envelop", () => {
  test("velden: id, van, naar, ts als ISO uit de injecteerbare klok, soort en herkomst", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "hoi");
    const e = bus.inbox("b")[0]!;
    expect(e).toMatchObject({ van: "a", naar: "b", hop: 1, herkomst: "schoon", soort: "bericht", tekst: "hoi", ts: new Date(T0).toISOString() });
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  test("standaardsoort is bericht", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "hoi");
    expect(bus.inbox("b")[0]!.soort).toBe("bericht");
  });

  test("herkomst komt van het afzender-record: extern wordt extern, ontbrekend wordt schoon", async () => {
    sessie("a", "", { herkomst: "extern", inbound: { standaard: "accept" } });
    open("b", "c");
    const bus = maak();
    await bus.send("a", "b", "van buiten");
    await bus.send("c", "b", "van binnen");
    expect(bus.inbox("b").map((e) => [e.van, e.herkomst])).toEqual([
      ["a", "extern"],
      ["c", "schoon"],
    ]);
  });

  test("een naam met meerdere levende records: het record met de laatste activiteit telt", async () => {
    open("a");
    sessie("b", "", { sinds: 100, inbound: { standaard: "accept" } });
    sessie("b", "", { sinds: 200, inbound: { standaard: "refuse" } });
    const bus = maak();
    expect(await bus.send("a", "b", "x")).toMatchObject({ reden: "geweigerd" });
    sessie("b", "", { sinds: 300, laatste_tool_om: 400, inbound: { standaard: "accept" } });
    expect(await bus.send("a", "b", "y")).toMatchObject({ ok: true });
  });
});

describe("contract na review: hop, herkomst, dubbel, wachtrij", () => {
  test("hop = hoogste hop in de draad + 1, ook zonder antwoord_op", async () => {
    open("a", "b");
    const bus = maak();
    for (let i = 1; i <= MAX_HOP; i++) {
      klok += 10;
      const [van, naar] = i % 2 ? ["a", "b"] : ["b", "a"];
      expect(await bus.send(van!, naar!, `m${i}`, { draad: "lus" })).toMatchObject({ ok: true });
      expect(bus.inbox(naar!).find((e) => e.tekst === `m${i}`)!.hop).toBe(i);
    }
    expect(await bus.send("a", "b", "omweg", { draad: "lus" })).toMatchObject({ ok: false, reden: "hop" });
    expect(await bus.send("a", "b", "andere draad", { draad: "nieuw" })).toMatchObject({ ok: true });
  });

  test("extern blijft extern in een draad, ook als de volgende afzender schoon is", async () => {
    sessie("x", "", { herkomst: "extern", inbound: { standaard: "accept" } });
    open("a", "b");
    const bus = maak();
    await bus.send("x", "a", "van buiten", { draad: "d" });
    klok += 10;
    await bus.send("a", "b", "doorgestuurd", { draad: "d" });
    expect(bus.inbox("b")[0]).toMatchObject({ herkomst: "extern", hop: 2 });
    klok += 10;
    await bus.send("a", "b", "andere draad", { draad: "e" });
    expect(bus.inbox("b").find((e) => e.tekst === "andere draad")!.herkomst).toBe("schoon");
  });

  test("een ack van een extern bericht maakt de ontvanger extern (markering, register ongemoeid); een schoon bericht niet", async () => {
    sessie("x", "", { herkomst: "extern", inbound: { standaard: "accept" } });
    open("a", "b");
    const bus = maak();
    const regVoor = JSON.stringify(alleRecords(staat).sort((p, q) => p.id.localeCompare(q.id)));
    await bus.send("b", "a", "schoon");
    bus.ack("a", bus.inbox("a").map((e) => e.id));
    expect(existsSync(join(staat, "peers/extern/a"))).toBe(false);
    await bus.send("x", "a", "van buiten");
    klok += 10;
    bus.ack("a", bus.inbox("a").map((e) => e.id));
    expect(existsSync(join(staat, "peers/extern/a"))).toBe(true);
    expect(statSync(join(staat, "peers/extern/a")).mode & 0o777).toBe(0o600);
    klok += 10;
    await bus.send("a", "b", "nu extern");
    expect(bus.inbox("b")[0]!.herkomst).toBe("extern");
    expect(JSON.stringify(alleRecords(staat).sort((p, q) => p.id.localeCompare(q.id)))).toBe(regVoor); // de bus schrijft niet in het register
  });

  test("inbox zonder ack van een extern bericht maakt de ontvanger ook extern; een afzender met alleen de markering is extern", async () => {
    sessie("x", "", { herkomst: "extern", inbound: { standaard: "accept" } });
    open("a", "b");
    const bus = maak();
    await bus.send("x", "a", "van buiten");
    expect(existsSync(join(staat, "peers/extern/a"))).toBe(false);
    bus.inbox("a"); // alleen kijken
    expect(existsSync(join(staat, "peers/extern/a"))).toBe(true);
    klok += 10;
    await bus.send("a", "b", "doorgestuurd");
    expect(bus.inbox("b")[0]!.herkomst).toBe("extern");
  });

  test("een schone inbox laat geen markering achter", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("b", "a", "schoon");
    bus.inbox("a");
    expect(existsSync(join(staat, "peers/extern"))).toBe(false);
  });

  test("dubbel telt ongeacht de uitkomst van de eerste: een geweigerde poging, daarna dezelfde tekst, is dubbel", async () => {
    open("a");
    sessie("b", "", { inbound: { standaard: "refuse" } });
    const bus = maak();
    expect(await bus.send("a", "b", "nee")).toMatchObject({ reden: "geweigerd" });
    sessie("b", "", { inbound: { standaard: "accept" }, sinds: klok + 1 });
    expect(await bus.send("a", "b", "nee")).toMatchObject({ ok: true, status: "dubbel" });
    expect(bus.inbox("b")).toEqual([]);
    klok += DUBBEL_VENSTER_MS;
    expect(await bus.send("a", "b", "nee")).toMatchObject({ status: "afgeleverd" });
  });

  test("wachtrij = ongelezen + vastgehouden samen", async () => {
    const afz = Array.from({ length: 5 }, (_, i) => `s${i}`);
    open(...afz);
    sessie("b", "", { inbound: { standaard: "accept", per_afzender: { s4: "hold" } } });
    const bus = maak();
    for (let i = 0; i < 30; i++) {
      klok += 10;
      await bus.send(`s${i % 4}`, "b", `u${i}`);
    }
    for (let i = 0; i < 20; i++) {
      klok += 10;
      expect(await bus.send("s4", "b", `v${i}`)).toMatchObject({ status: "vastgehouden" });
    }
    expect(await bus.send("s0", "b", "te veel")).toMatchObject({ reden: "vol" });
    klok += 60_000; // tempo weer vrij
    expect(await bus.send("s4", "b", "ook te veel")).toMatchObject({ reden: "vol" });
    expect(bus.list().find((p) => p.naam === "b")).toMatchObject({ ongelezen: 30, vastgehouden: 20 });
    expect(await bus.vrijgeven("b")).toBe(20); // verplaatsen kost geen ruimte
    expect(bus.inbox("b")).toHaveLength(50);
  });

  test("list toont de tellers ongelezen en vastgehouden", async () => {
    open("a");
    sessie("b", "", { inbound: { standaard: "hold" } });
    const bus = maak();
    await bus.send("a", "b", "vast");
    expect(bus.list().find((p) => p.naam === "b")).toMatchObject({ ongelezen: 0, vastgehouden: 1 });
  });
});

describe("notifyWhenIdle: uitslag", () => {
  test("onbekend doel of onbekende abonnee geeft een fout, geen abonnement", () => {
    open("a");
    const bus = maak();
    expect(bus.notifyWhenIdle("a", "niemand")).toMatchObject({ ok: false, reden: "onbekend" });
    expect(bus.notifyWhenIdle("niemand", "a")).toMatchObject({ ok: false, reden: "geen_afzender" });
  });

  test("doel al idle (of klaar, vrij, weg): de melding komt meteen, al_idle true", async () => {
    open("a");
    for (const t of ["idle", "klaar", "vrij", "weg"] as const) {
      sessie(`w-${t}`, "", { toestand: t });
      const bus = maak();
      expect(bus.notifyWhenIdle("a", `w-${t}`)).toEqual({ ok: true, al_idle: true });
      const [e] = bus.inbox("a");
      expect(e).toMatchObject({ van: `w-${t}`, naar: "a", soort: "idle", tekst: `w-${t} is ${t}`, hop: 1 });
      bus.ack("a", [e!.id]);
    }
  });

  test("doel bezig: al_idle false en een abonnement", () => {
    open("a", "w");
    const bus = maak();
    expect(bus.notifyWhenIdle("a", "w")).toEqual({ ok: true, al_idle: false });
    expect(bus.inbox("a")).toEqual([]);
  });
});

describe("inbox en ack", () => {
  test("inbox is oudste eerst, verandert niets en is per ontvanger", async () => {
    open("a", "b", "c");
    const bus = maak();
    for (const t of ["een", "twee", "drie"]) {
      klok += 5;
      await bus.send("a", "b", t);
    }
    await bus.send("a", "c", "voor c");
    expect(bus.inbox("b").map((e) => e.tekst)).toEqual(["een", "twee", "drie"]);
    expect(bus.inbox("b")).toHaveLength(3);
    expect(bus.inbox("c").map((e) => e.tekst)).toEqual(["voor c"]);
    expect(bus.inbox("a")).toEqual([]);
  });

  test("ack: alleen die ids verdwijnen; onbekende ids en een tweede ack doen niets", async () => {
    open("a", "b");
    const bus = maak();
    for (const t of ["een", "twee", "drie"]) {
      klok += 5;
      await bus.send("a", "b", t);
    }
    const [e1, e2] = bus.inbox("b");
    bus.ack("b", [e1!.id, "bestaat-niet"]);
    bus.ack("b", [e1!.id]);
    expect(bus.inbox("b").map((e) => e.tekst)).toEqual(["twee", "drie"]);
    bus.ack("b", [e2!.id]);
    expect(bus.inbox("b").map((e) => e.tekst)).toEqual(["drie"]);
  });

  test("ack van de ontvanger van een ander bericht doet niets (id hoort bij een andere inbox)", async () => {
    open("a", "b", "c");
    const bus = maak();
    await bus.send("a", "b", "voor b");
    const id = bus.inbox("b")[0]!.id;
    bus.ack("c", [id]);
    expect(bus.inbox("b")).toHaveLength(1);
  });

  test("een gelezen bericht blijft vindbaar voor een antwoord (hop) en wordt na de retentie opgeruimd", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "vraag");
    const e = bus.inbox("b")[0]!;
    bus.ack("b", [e.id]);
    await bus.send("b", "a", "antwoord", { antwoord_op: e.id });
    expect(bus.inbox("a")[0]!.hop).toBe(2);
    klok += RETENTIE_MS + 1000;
    await bus.send("a", "b", "nieuw"); // schrijven ruimt op
    await bus.send("b", "a", "te laat", { antwoord_op: e.id });
    expect(bus.inbox("a").find((x) => x.tekst === "te laat")!.hop).toBe(1);
  });

  test("inbox geeft hoogstens MAX_WACHTRIJ (ook als vrijgeven er meer in zou zetten)", async () => {
    const afz = Array.from({ length: 5 }, (_, i) => `s${i}`);
    open(...afz);
    sessie("b", "", { inbound: { standaard: "hold" } });
    const bus = maak();
    for (let i = 0; i < MAX_WACHTRIJ; i++) {
      klok += 10;
      await bus.send(afz[i % 5]!, "b", `m${i}`);
    }
    expect(await bus.vrijgeven("b")).toBe(MAX_WACHTRIJ);
    expect(bus.inbox("b")).toHaveLength(MAX_WACHTRIJ);
    expect(await bus.vrijgeven("b")).toBe(0);
  });
});

describe("list", () => {
  test("levende sessies, niet weg, met vendor en host (standaard claude/tui) en machine", () => {
    sessie("a", "lead", { vendor: "codex", host: "t3" });
    sessie("b", "");
    sessie("w", "", { toestand: "weg" });
    const peers = maak().list();
    expect(peers.map((p) => p.naam).sort()).toEqual(["a", "b"]);
    expect(peers.find((p) => p.naam === "a")).toMatchObject({ vendor: "codex", host: "t3", lead: "lead", cwd: "/w/a", machine: "testmachine", toestand: "bezig" });
    expect(peers.find((p) => p.naam === "b")).toMatchObject({ vendor: "claude", host: "tui" });
  });

  test("subagents staan er niet in", () => {
    sessie("sub", "", { soort: "subagent" });
    expect(maak().list()).toEqual([]);
  });
});

describe("wekken", () => {
  test("na opslaan één wek met het aantal ongelezen en het doel uit het register; de uitslag zit in de SendUitslag", async () => {
    open("a");
    sessie("b", "", { vendor: "codex", host: "tui", thread_id: "th-1", codex_home: "/c", inbound: { standaard: "accept" } });
    const u = await maak().send("a", "b", "hoi");
    expect(u).toMatchObject({ ok: true, status: "afgeleverd", gewekt: { gewekt: true, route: "nep" } });
    expect(wekken).toEqual([{ doel: { naam: "b", vendor: "codex", host: "tui", toestand: "bezig", thread_id: "th-1", codex_home: "/c" }, aantal: 1 }]);
  });

  test("binnen het wekvenster wacht de send tot het venster om is en wekt dan met alles wat er ligt (geen verloren seintje)", async () => {
    open("a", "b");
    const bus = maak();
    expect(await bus.send("a", "b", "een")).toMatchObject({ gewekt: { gewekt: true } });
    klok += WEK_VENSTER_MS - 1000;
    const t = klok;
    expect(await bus.send("a", "b", "twee")).toMatchObject({ ok: true, status: "afgeleverd", gewekt: { gewekt: true, route: "nep" } });
    expect(klok).toBe(t + 1000); // precies tot het eind van het venster gewacht
    expect(wekken.map((w) => w.aantal)).toEqual([1, 2]);
    klok += WEK_VENSTER_MS;
    expect(await bus.send("a", "b", "drie")).toMatchObject({ gewekt: { gewekt: true } });
    expect(wekken.map((w) => w.aantal)).toEqual([1, 2, 3]);
  });

  test("het geval van opus: bericht 2 binnen het venster, ontvanger had bericht 1 al gelezen: toch gewekt (aantal 1)", async () => {
    open("a", "w");
    const bus = maak();
    klok += 10_000;
    await bus.send("a", "w", "1");
    bus.ack("w", bus.inbox("w").map((e) => e.id));
    klok += 1000;
    await bus.send("a", "w", "2");
    expect(wekken.map((x) => x.aantal)).toEqual([1, 1]);
  });

  test("drie berichten tegelijk binnen het venster: één wachter wekt één keer met alles; de anderen wachten niet", async () => {
    open("a", "b", "c", "d");
    const wachtend: (() => void)[] = [];
    const bus = maakBus({ staat, nu: () => klok, wekker: nepWekker, wacht: (ms) => new Promise<void>((r) => wachtend.push(() => ((klok += ms), r()))) });
    await bus.send("a", "b", "een");
    klok += 100;
    const p2 = bus.send("a", "b", "twee");
    const p3 = bus.send("c", "b", "drie");
    const p4 = bus.send("d", "b", "vier");
    const [u3, u4] = await Promise.all([p3, p4]);
    expect(u3).toMatchObject({ ok: true, gewekt: null });
    expect(u4).toMatchObject({ ok: true, gewekt: null });
    expect(wachtend).toHaveLength(1);
    wachtend[0]!();
    expect(await p2).toMatchObject({ ok: true, gewekt: { gewekt: true } });
    expect(wekken.map((w) => w.aantal)).toEqual([1, 4]);
  });

  test("een wachter die nooit terugkomt (proces gedood): na twee vensters neemt de volgende send het over", async () => {
    open("a", "b");
    const bus = maakBus({ staat, nu: () => klok, wekker: nepWekker, wacht: () => new Promise<void>(() => {}) });
    await bus.send("a", "b", "een");
    klok += 100;
    void bus.send("a", "b", "twee"); // blijft hangen (gedode wachter), `open` staat vast
    klok += WEK_VENSTER_MS * 2;
    const bus2 = maak();
    expect(await bus2.send("a", "b", "drie")).toMatchObject({ gewekt: { gewekt: true } });
    expect(wekken.map((w) => w.aantal)).toEqual([1, 3]);
  });

  test("is het bericht na het wachten al gelezen, dan wordt er niet gewekt", async () => {
    open("a", "b");
    let bus: ReturnType<typeof maak>;
    bus = maakBus({
      staat,
      nu: () => klok,
      wekker: nepWekker,
      wacht: async (ms) => {
        klok += ms;
        bus.ack("b", bus.inbox("b").map((e) => e.id)); // de ontvanger las het intussen
      },
    });
    await bus.send("a", "b", "een");
    klok += 100;
    expect(await bus.send("a", "b", "twee")).toMatchObject({ ok: true, gewekt: null });
    expect(wekken).toHaveLength(1);
  });

  test("het wekvenster is per ontvanger", async () => {
    open("a", "b", "c");
    const bus = maak();
    await bus.send("a", "b", "x");
    await bus.send("a", "c", "x");
    expect(wekken.map((w) => w.doel.naam)).toEqual(["b", "c"]);
  });

  test("een wekker die gooit maakt de send niet mislukt", async () => {
    open("a", "b");
    wekAntwoord = async () => {
      throw new Error("socket weg");
    };
    const u = await maak().send("a", "b", "hoi");
    expect(u).toMatchObject({ ok: true, status: "afgeleverd", gewekt: { gewekt: false, route: "fout" } });
    expect(maak().inbox("b")).toHaveLength(1);
  });

  test("een wekker die niet wekt (route + melding) wordt doorgegeven", async () => {
    open("a", "b");
    wekAntwoord = async () => ({ gewekt: false, route: "acp", melding: "niet in fase 1" });
    const u = await maak().send("a", "b", "hoi");
    expect(u).toMatchObject({ gewekt: { gewekt: false, route: "acp" } });
    expect(JSON.stringify(u)).not.toContain("niet in fase 1"); // de afzender ziet geen melding van de ontvanger-kant
  });

  test("zonder wekker: route geen, niet gewekt", async () => {
    open("a", "b");
    const bus = maakBus({ staat, nu: () => klok, wacht: async (ms) => void (klok += ms) });
    expect(await bus.send("a", "b", "hoi")).toMatchObject({ ok: true, gewekt: { gewekt: false, route: "geen" } });
  });
});

describe("idle-abonnement", () => {
  test("eenmalig: bij idle krijgt de abonnee één envelop soort idle van het doel, gewekt; een tweede idle niets", async () => {
    open("lead", "w");
    const bus = maak();
    bus.notifyWhenIdle("lead", "w");
    await bus.idleGemeld("w", "idle");
    const [e] = bus.inbox("lead");
    expect(e).toMatchObject({ van: "w", naar: "lead", soort: "idle", herkomst: "schoon", hop: 1 });
    expect(e!.tekst).toContain("idle");
    expect(wekken.map((x) => x.doel.naam)).toEqual(["lead"]);
    bus.ack("lead", [e!.id]);
    await bus.idleGemeld("w", "idle");
    expect(bus.inbox("lead")).toEqual([]);
  });

  test("klaar, vrij en weg leveren af; bezig en goedkeuring niet (en wissen het abonnement niet)", async () => {
    open("lead");
    for (const t of ["klaar", "vrij", "weg"] as const) {
      const bus = maak();
      sessie("w", "", { inbound: { standaard: "accept" } });
      bus.notifyWhenIdle("lead", "w");
      if (t === "klaar") {
        await bus.idleGemeld("w", "bezig");
        await bus.idleGemeld("w", "goedkeuring");
        expect(bus.inbox("lead")).toEqual([]);
      }
      await bus.idleGemeld("w", t);
      const nu = bus.inbox("lead");
      expect(nu).toHaveLength(1);
      expect(nu[0]!.tekst).toContain(t);
      bus.ack("lead", [nu[0]!.id]);
      klok += WEK_VENSTER_MS;
    }
  });

  test("twee abonnees krijgen elk één melding; dezelfde abonnee tweemaal telt eenmaal", async () => {
    open("lead", "andere", "w");
    const bus = maak();
    bus.notifyWhenIdle("lead", "w");
    bus.notifyWhenIdle("lead", "w");
    bus.notifyWhenIdle("andere", "w");
    await bus.idleGemeld("w", "klaar");
    expect(bus.inbox("lead")).toHaveLength(1);
    expect(bus.inbox("andere")).toHaveLength(1);
  });

  test("een abonnement op een ander doel blijft staan", async () => {
    open("lead", "w", "x");
    const bus = maak();
    bus.notifyWhenIdle("lead", "x");
    await bus.idleGemeld("w", "idle");
    expect(bus.inbox("lead")).toEqual([]);
    await bus.idleGemeld("x", "idle");
    expect(bus.inbox("lead")).toHaveLength(1);
  });

  test("idleGemeld zonder abonnement doet niets en gooit niet; een idle-melding omzeilt het inbound-beleid", async () => {
    sessie("lead", "", { inbound: { standaard: "refuse" } });
    open("w");
    const bus = maak();
    await bus.idleGemeld("w", "idle");
    bus.notifyWhenIdle("lead", "w");
    await bus.idleGemeld("w", "idle");
    expect(bus.inbox("lead")).toHaveLength(1);
  });
});

describe("opslag", () => {
  test("mappen 0700 en bestanden 0600 onder <staat>/peers, en niets buiten de staatmap", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "hoi");
    bus.notifyWhenIdle("a", "b");
    const e = bus.inbox("b")[0]!;
    bus.ack("b", [e.id]);
    const root = join(staat, "peers");
    const modus = (p: string) => statSync(p).mode & 0o777;
    expect(modus(root)).toBe(0o700);
    const bestanden: string[] = [];
    const loop = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        if (n.isDirectory()) {
          expect(modus(p)).toBe(0o700);
          loop(p);
        } else bestanden.push(p);
      }
    };
    loop(root);
    expect(bestanden.length).toBeGreaterThan(3);
    for (const p of bestanden) expect(modus(p)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["staat"]);
    expect(slotBestanden()).toEqual([]); // geen lock of tmp achtergebleven
  });

  test("een kapotte regel in een inbox wordt overgeslagen", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "goed");
    writeFileSync(join(staat, "peers/inbox/b.jsonl"), `{kapot\n${JSON.stringify({ id: "x", van: "a", naar: "b", draad: "d", ts: new Date(T0).toISOString(), hop: 1, herkomst: "schoon", soort: "bericht", tekst: "ook goed" })}\n`, { flag: "a" });
    expect(bus.inbox("b").map((e) => e.tekst)).toEqual(["goed", "ook goed"]);
  });

  test("een verse lock van een dode pid is meteen vrij; een lock ouder dan 10 s ook (pid-hergebruik)", async () => {
    open("a", "b", "c");
    const dood = Bun.spawnSync(["true"]).pid;
    mkdirSync(join(staat, "peers/slot/post"), { recursive: true, mode: 0o700 });
    writeFileSync(join(staat, "peers/slot/post/b.lock"), `${dood}-abc`);
    expect(await maak().send("a", "b", "hoi")).toMatchObject({ ok: true });
    expect(existsSync(join(staat, "peers/slot/post/b.lock"))).toBe(false);

    // levende pid (de onze), maar de lock is 60 s oud
    const oud = join(staat, "peers/slot/post/c.lock");
    writeFileSync(oud, `${process.pid}-oud`);
    const lang = new Date(Date.now() - 60_000);
    utimesSync(oud, lang, lang);
    expect(await maak().send("a", "c", "hoi")).toMatchObject({ ok: true });
    expect(existsSync(oud)).toBe(false);
  });

  test("een lock bevat pid en token van de houder en wordt na afloop alleen verwijderd als hij nog van ons is", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "hoi");
    expect(slotBestanden()).toEqual([]);
    // een lock van iemand anders (levende pid, vers) blijft staan; wij wachten niet eeuwig maar mogen hem niet slopen
    const vreemd = join(staat, "peers/slot/post/b.lock");
    writeFileSync(vreemd, `${process.pid}-vreemd`);
    const ouder = maak();
    // inbox probeert de lock te krijgen en geeft op na SLOT_MAX_MS: dat is te traag voor een unittest, dus alleen controleren dat de lock er nog staat zodra we hem opruimen
    expect(readFileSync(vreemd, "utf8")).toBe(`${process.pid}-vreemd`);
    rmSync(vreemd);
    expect(ouder.inbox("b")).toHaveLength(1);
  });

  test("de send gooit nooit: een onleesbare staatmap geeft een uitslag", async () => {
    open("a", "b");
    writeFileSync(join(staat, "peers"), "ik ben een bestand"); // peers/ kan geen map worden
    const u = await maak().send("a", "b", "hoi");
    expect(u.ok).toBe(false);
  });
});

describe("namen: geen bestandsnaam buiten NAAM", () => {
  const slecht = ["..", ".", "", "a/b", "../x", "a b", ".verborgen", "x".repeat(101), "a\u0000b"];

  test("geldigeNaam: letters, cijfers, . _ - en niet beginnend met een punt, hoogstens 100", () => {
    for (const n of ["a", "lead-peerbus", "w_1", "a.b", "A-1", "x".repeat(100)]) expect(geldigeNaam(n)).toBe(true);
    for (const n of slecht) expect(geldigeNaam(n)).toBe(false);
    expect(geldigeNaam(undefined)).toBe(false);
    expect(geldigeNaam(5)).toBe(false);
  });

  test("elke ingang weigert een ongeldige naam en laat de opslag heel (proef opus: `..` wiste peers/)", async () => {
    open("a", "b");
    const bus = maak();
    await bus.send("a", "b", "bewaar mij");
    const voor = () => JSON.stringify([readdirSync(join(staat, "peers")).sort(), readdirSync(join(staat, "peers/inbox")).sort(), readFileSync(join(staat, "peers/inbox/b.jsonl"), "utf8")]);
    const ervoor = voor();
    for (const n of slecht) {
      sessie(n === "" ? "leeg" : `r${slecht.indexOf(n)}`, "", { naam: n, inbound: { standaard: "accept" } } as Partial<Rec>);
      expect(await bus.send(n, "b", "x")).toMatchObject({ ok: false, reden: "geen_afzender" });
      expect(await bus.send("a", n, "x")).toMatchObject({ ok: false, reden: "onbekend" });
      expect(bus.inbox(n)).toEqual([]);
      bus.ack(n, ["id"]);
      expect(bus.vastgehouden(n)).toEqual([]);
      expect(await bus.vrijgeven(n)).toBe(0);
      expect(bus.notifyWhenIdle(n, "b")).toMatchObject({ ok: false, reden: "geen_afzender" });
      expect(bus.notifyWhenIdle("a", n)).toMatchObject({ ok: false, reden: "onbekend" });
      await bus.idleGemeld(n, "idle");
    }
    expect(bus.list().map((p) => p.naam).sort()).toEqual(["a", "b"]); // sessies met een ongeldige naam zijn niet bereikbaar
    expect(voor()).toBe(ervoor);
    expect(bus.inbox("b").map((e) => e.tekst)).toEqual(["bewaar mij"]);
  });

  test("a/b en a_b delen geen inbox meer: `a/b` is ongeldig, `a_b` en `a-b` zijn verschillende ontvangers", async () => {
    open("x", "a_b", "a-b");
    const bus = maak();
    await bus.send("x", "a_b", "voor a_b");
    expect(bus.inbox("a-b")).toEqual([]);
    expect(bus.inbox("a_b")).toHaveLength(1);
  });
});

describe("herstelronde: inbound faalt dicht", () => {
  test("per_afzender[\"constructor\"] en andere prototype-namen tellen niet als beleid", async () => {
    sessie("constructor");
    sessie("toString");
    sessie("__proto__x");
    sessie("b", "", { inbound: { standaard: "refuse", per_afzender: {} } });
    const bus = maak();
    for (const van of ["constructor", "toString"]) expect(await bus.send(van, "b", "x")).toMatchObject({ ok: false, reden: "geweigerd" });
  });

  test("een ongeldige waarde (\"Hold\", \"ACCEPT\", een getal, een object) telt als hold", async () => {
    open("a");
    for (const [i, inbound] of [
      { per_afzender: { a: "Hold" } },
      { standaard: "ACCEPT" },
      { standaard: "aanvaard" },
      { per_afzender: { a: 1 } },
      { per_afzender: { a: { x: 1 } } },
      { per_afzender: "accept" },
      "accept",
      5,
    ].entries()) {
      sessie(`ont${i}`, "", { inbound } as unknown as Partial<Rec>);
      expect(await maak().send("a", `ont${i}`, "x")).toMatchObject({ ok: true, status: "vastgehouden" });
    }
  });

  test("een geldige waarde werkt nog: per_afzender refuse gaat voor standaard accept", async () => {
    open("a");
    sessie("b", "", { inbound: { standaard: "accept", per_afzender: { a: "refuse" } } });
    expect(await maak().send("a", "b", "x")).toMatchObject({ reden: "geweigerd" });
  });
});

describe("herstelronde: tempo telt elke poging", () => {
  test("te_lang, onbekende ontvanger en onbekende afzender tellen mee voor het tempo", async () => {
    open("a", "b");
    const bus = maakBus({ staat, nu: () => klok, wekker: nepWekker, wacht: async () => {} });
    for (let i = 0; i < 10; i++) expect(await bus.send("a", "b", "x".repeat(MAX_TEKST + 1))).toMatchObject({ reden: "te_lang" });
    for (let i = 0; i < MAX_PER_MINUUT - 10; i++) expect(await bus.send("a", "niemand", "x")).toMatchObject({ reden: "onbekend" });
    expect(await bus.send("a", "b", "gewoon")).toMatchObject({ ok: false, reden: "te_veel" });
    expect(bus.inbox("b")).toEqual([]);
    for (let i = 0; i < MAX_PER_MINUUT; i++) expect(await bus.send("spook", "b", "x")).toMatchObject({ reden: "geen_afzender" });
    open("spook"); // pas nu in het register: de eerdere pogingen tellen al
    expect(await bus.send("spook", "b", "x")).toMatchObject({ reden: "te_veel" });
  });

  test("een poging die op hop wordt geweigerd telt ook", async () => {
    open("a", "b");
    const bus = maakBus({ staat, nu: () => klok, wekker: nepWekker, wacht: async () => {} });
    for (let i = 1; i <= MAX_HOP; i++) {
      klok += 1;
      await bus.send(i % 2 ? "a" : "b", i % 2 ? "b" : "a", `m${i}`, { draad: "d" });
    }
    for (let i = 0; i < MAX_PER_MINUUT - MAX_HOP / 2; i++) {
      klok += 1;
      await bus.send("a", "b", `x${i}`, { draad: "d" });
    }
    klok += 1;
    expect(await bus.send("a", "b", "nog een", { draad: "nieuw" })).toMatchObject({ reden: "te_veel" });
  });
});

describe("herstelronde: hop binnen de lock van de ontvanger", () => {
  test("vier processen sturen tegelijk in dezelfde draad: vier verschillende hops 1..4", async () => {
    sessie("ont", "", { inbound: { standaard: "accept" } });
    const afz = ["s0", "s1", "s2", "s3"];
    for (const a of afz) sessie(a, "", { inbound: { standaard: "accept" } });
    const code = `
      const { maakBus } = await import(process.argv[1]);
      const bus = maakBus({ staat: process.argv[2], wacht: async () => {} });
      const u = await bus.send(process.argv[3], "ont", "van " + process.argv[3], { draad: "gedeeld" });
      process.exit(u.ok ? 0 : 3);
    `;
    const procs = afz.map((a) => Bun.spawn(["bun", "-e", code, join(import.meta.dir, "bus.ts"), staat, a], { stdout: "pipe", stderr: "pipe" }));
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
    expect(maak().inbox("ont").map((e) => e.hop).sort()).toEqual([1, 2, 3, 4]);
  }, 30_000);
});

describe("parallel", () => {
  test("zes processen schrijven tegelijk naar één ontvanger: niets kwijt, niets dubbel, geen kapotte regel", async () => {
    sessie("ont", "", { inbound: { standaard: "accept" } });
    const afz = Array.from({ length: 6 }, (_, i) => `s${i}`);
    for (const a of afz) sessie(a, "", { inbound: { standaard: "accept" } });
    const busPad = join(import.meta.dir, "bus.ts");
    const code = `
      const { maakBus } = await import(process.argv[1]);
      const bus = maakBus({ staat: process.argv[2], wacht: async () => {} });
      const van = process.argv[3];
      const uit = [];
      for (let i = 0; i < 8; i++) uit.push((await bus.send(van, "ont", van + "-" + i)).ok);
      process.exit(uit.every(Boolean) ? 0 : 3);
    `;
    const procs = afz.map((a) => Bun.spawn(["bun", "-e", code, busPad, staat, a], { stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual(afz.map(() => 0));
    const bus = maak();
    const ids = bus.inbox("ont");
    expect(ids).toHaveLength(48);
    expect(new Set(ids.map((e) => e.id)).size).toBe(48);
    expect(new Set(ids.map((e) => e.tekst)).size).toBe(48);
    // per afzender in de volgorde waarin hij schreef
    for (const a of afz) expect(ids.filter((e) => e.van === a).map((e) => e.tekst)).toEqual(Array.from({ length: 8 }, (_, i) => `${a}-${i}`));
    expect(slotBestanden()).toEqual([]);
  }, 30_000);

  test("parallel ack en send: een bericht dat binnenkomt tijdens een ack gaat niet verloren", async () => {
    sessie("ont", "", { inbound: { standaard: "accept" } });
    const afz = Array.from({ length: 4 }, (_, i) => `s${i}`);
    for (const a of afz) sessie(a, "", { inbound: { standaard: "accept" } });
    const bus = maak();
    await bus.send("s0", "ont", "eerste");
    const eerste = bus.inbox("ont")[0]!;
    const busPad = join(import.meta.dir, "bus.ts");
    const code = `
      const { maakBus } = await import(process.argv[1]);
      const bus = maakBus({ staat: process.argv[2], wacht: async () => {} });
      for (let i = 0; i < 6; i++) await bus.send(process.argv[3], "ont", process.argv[3] + "-" + i);
    `;
    const procs = afz.slice(1).map((a) => Bun.spawn(["bun", "-e", code, busPad, staat, a], { stdout: "pipe", stderr: "pipe" }));
    bus.ack("ont", [eerste.id]);
    await Promise.all(procs.map((p) => p.exited));
    const rest = bus.inbox("ont");
    expect(rest).toHaveLength(18);
    expect(rest.some((e) => e.id === eerste.id)).toBe(false);
  }, 30_000);
});
