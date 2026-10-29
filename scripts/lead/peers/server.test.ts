import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Rec, identiteitPad, nieuwRecord, schrijfIdentiteit, schrijfRecord } from "../hooks/register";
import { maakBus } from "./bus";
import { leadProefNaam, metIdentiteit, verwerk } from "./server";
import { toon } from "./types";

// Echte serverprocessen op een tijdelijke staatmap; de echte ~/.local/state/lab-lead blijft ongemoeid.

const T0 = 1_700_000_000_000;
const SERVER = join(import.meta.dir, "server.ts");
let dir: string;
let staat: string;

const bus = () => maakBus({ staat, nu: () => T0, machine: "testmachine" });
function sessie(naam: string, lead = ""): void {
  schrijfRecord(staat, { ...nieuwRecord(`id-${naam}`, { LAB_AGENT_NAAM: naam, LAB_LEAD_NAAM: lead }, `/w/${naam}`, T0), inbound: { standaard: "accept" } } as Rec);
}

/** Start een echt proces, stuurt de regels en wacht tot stdin dicht is; geeft de antwoorden als objecten. */
async function draaiProces(naam: string | undefined, regels: unknown[], cwd?: string): Promise<any[]> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_") && k !== "LAB_AGENT_NAAM" && k !== "LAB_AGENT_ROL") env[k] = v;
  env.LAB_LEAD_STAAT = staat;
  if (naam) env.LAB_AGENT_NAAM = naam;
  const p = Bun.spawn(["bun", SERVER], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) });
  p.stdin.write(regels.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  await p.stdin.end();
  const uit = await new Response(p.stdout).text();
  await p.exited;
  return uit.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const roep = (id: number, name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const tekstVan = (r: any) => r.result.content[0].text as string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-peers-mcp-"));
  staat = join(dir, "staat");
  sessie("a");
  sessie("b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("protocol via een echt proces", () => {
  test("initialize, notificatie (geen antwoord), ping en tools/list", async () => {
    const r = await draaiProces("a", [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ]);
    expect(r.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(r[0].result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "peers" }, capabilities: { tools: {} } });
    expect(r[2].result.tools.map((t: any) => t.name)).toEqual(["send", "inbox", "list", "notify_when_idle"]);
  });

  test("onbekende methode, kapotte JSON en onbekende tool geven een JSON-RPC-fout; het proces blijft leven", async () => {
    const r = await draaiProces("a", [{ jsonrpc: "2.0", id: 1, method: "bestaat/niet" }, "{kapot", roep(2, "vrijgeven", { naam: "b" }), roep(3, "list")]);
    expect(r[0].error.code).toBe(-32601);
    expect(r[1]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(r[2].error.code).toBe(-32602);
    expect(r[3].id).toBe(3);
  });
});

describe("tools via een echt proces", () => {
  test("send komt aan; inbox van de ontvanger toont toon() en ackt; tweede inbox is leeg", async () => {
    const s = await draaiProces("a", [roep(1, "send", { naar: "b", tekst: "hoi b" })]);
    expect(tekstVan(s[0])).toMatch(/^afgeleverd [0-9a-f-]{36}, wek: nee \(socket\)$/);
    const verwacht = toon(bus().inbox("b")[0]!);
    const i = await draaiProces("b", [roep(1, "inbox"), roep(2, "inbox")]);
    expect(tekstVan(i[0])).toBe(verwacht);
    expect(tekstVan(i[1])).toBe("Geen berichten.");
    expect(bus().inbox("b")).toEqual([]);
  });

  test("draad en antwoord_op worden doorgegeven", async () => {
    await draaiProces("a", [roep(1, "send", { naar: "b", tekst: "vraag", draad: "d1" })]);
    const vraag = bus().inbox("b")[0]!;
    await draaiProces("b", [roep(1, "send", { naar: "a", tekst: "antwoord", antwoord_op: vraag.id })]);
    expect(bus().inbox("a")[0]).toMatchObject({ draad: "d1", hop: 2, antwoord_op: vraag.id });
  });

  test("een geweigerde send is een tool-fout met reden (isError)", async () => {
    const r = await draaiProces("a", [roep(1, "send", { naar: "niemand", tekst: "hoi" })]);
    expect(r[0].result.isError).toBe(true);
    expect(tekstVan(r[0])).toContain("onbekend");
  });

  test("ongeldige argumenten geven een tool-fout", async () => {
    const r = await draaiProces("a", [roep(1, "send", { naar: "b" }), roep(2, "send", { naar: "b", tekst: "x", draad: 5 }), roep(3, "notify_when_idle", {})]);
    for (const x of r) expect(x.result.isError).toBe(true);
    expect(bus().inbox("b")).toEqual([]);
  });

  test("list toont levende sessies met tellers", async () => {
    await draaiProces("a", [roep(1, "send", { naar: "b", tekst: "hoi" })]);
    const r = await draaiProces("a", [roep(1, "list")]);
    const peers = JSON.parse(tekstVan(r[0]));
    expect(peers.map((p: any) => [p.naam, p.ongelezen, p.vastgehouden]).sort()).toEqual([["a", 0, 0], ["b", 1, 0]]);
  });

  test("notify_when_idle: abonneert op een actief doel, onbekend doel is een fout", async () => {
    const r = await draaiProces("a", [roep(1, "notify_when_idle", { naam: "b" }), roep(2, "notify_when_idle", { naam: "niemand" })]);
    expect(r[0].result.isError).toBeUndefined();
    expect(tekstVan(r[0])).toMatch(/Je krijgt één melding|al idle/);
    expect(r[1].result.isError).toBe(true);
  });

  test("zonder LAB_AGENT_NAAM geven alle tools een duidelijke fout", async () => {
    const r = await draaiProces(undefined, [roep(1, "send", { naar: "b", tekst: "x" }), roep(2, "inbox"), roep(3, "notify_when_idle", { naam: "b" }), roep(4, "list")]);
    for (const x of r) {
      expect(x.result.isError).toBe(true);
      expect(tekstVan(x)).toContain("LAB_AGENT_NAAM");
    }
  });

  test("een afzender die niet in het register staat krijgt geen_afzender", async () => {
    const r = await draaiProces("spook", [roep(1, "send", { naar: "b", tekst: "x" })]);
    expect(tekstVan(r[0])).toContain("geen_afzender");
  });
});

describe("leeslus", () => {
  const env = () => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) e[k] = v;
    return { ...e, LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: "b" };
  };

  test("stdout dicht: het bericht blijft ongelezen (geen ack zonder levering)", async () => {
    await bus().send("a", "b", "hoi");
    const p = Bun.spawn(["bun", SERVER], { env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await p.stdout.cancel(); // lezer weg vóór het antwoord
    p.stdin.write(JSON.stringify(roep(1, "inbox")) + "\n");
    await p.stdin.end();
    await p.exited;
    expect(bus().inbox("b")).toHaveLength(1);
  });

  test("een ack die gooit: geen stacktrace, volgende verzoeken worden nog beantwoord, nette exit", async () => {
    await bus().send("a", "b", "hoi");
    // een map op de plek van het gelezen-bestand laat ack falen (EISDIR)
    mkdirSync(join(staat, "peers", "inbox", "b.gelezen"), { recursive: true });
    const p = Bun.spawn(["bun", SERVER], { env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(JSON.stringify(roep(1, "inbox")) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) + "\n");
    await p.stdin.end();
    const [uit, fout] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(0);
    expect(uit.split("\n").filter(Boolean).map((l) => JSON.parse(l).id)).toContain(3);
    expect(fout).toContain("peers-mcp:");
    expect(fout).not.toContain("    at ");
  });
});

describe("verwerk", () => {
  test("protocolVersion: bekende versie terug, onbekende wordt de nieuwste", async () => {
    const v = (pv: unknown) => verwerk({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: pv } }, bus(), {}).then((x) => (x.antwoord!.result as any).protocolVersion);
    expect(await v("2024-11-05")).toBe("2024-11-05");
    expect(await v("2025-06-18")).toBe("2025-06-18");
    expect(await v("2099-01-01")).toBe("2025-06-18");
    expect(await v(undefined)).toBe("2025-06-18");
  });

  test("batch, losse waarde en object als id geven -32600 met id null", async () => {
    for (const m of [[{ id: 1, method: "ping" }], 5, null, "x", { jsonrpc: "2.0", id: { a: 1 }, method: "ping" }]) {
      const v = await verwerk(m as any, bus(), {});
      expect(v.antwoord).toMatchObject({ id: null, error: { code: -32600 } });
    }
  });

  test("een gooiende bus geeft de vaste fouttekst zonder pad of details", async () => {
    const kapot = { inbox: () => { throw new Error("EACCES /geheim/pad"); } } as any;
    const v = await verwerk(roep(1, "inbox") as any, kapot, { LAB_AGENT_NAAM: "b" });
    const t = (v.antwoord!.result as any).content[0].text;
    expect(t).toContain("interne fout");
    expect(t).not.toContain("/geheim");
  });

  test("een tools/call zonder id (notificatie) heeft geen bijwerking: inbox ackt niet", async () => {
    await bus().send("a", "b", "hoi");
    const v = await verwerk({ jsonrpc: "2.0", method: "tools/call", params: { name: "inbox", arguments: {} } }, bus(), { LAB_AGENT_NAAM: "b" });
    expect(v).toEqual({ antwoord: null });
    expect(bus().inbox("b")).toHaveLength(1);
  });

  test("inbox ackt pas na `daarna`, niet bij het antwoord zelf", async () => {
    await bus().send("a", "b", "hoi");
    const v = await verwerk(roep(1, "inbox") as any, bus(), { LAB_AGENT_NAAM: "b" });
    expect(bus().inbox("b")).toHaveLength(1);
    v.daarna!();
    expect(bus().inbox("b")).toEqual([]);
  });

});

describe("identiteit zonder LAB_AGENT_NAAM (Codex-thread in T3)", () => {
  const ident = (naam: string, ts = T0) => ({ naam, rol: "agent", lead: "lead-x", opdracht: "/o", spawn_id: "sp-1", ts });
  let wt: string;
  beforeEach(() => {
    wt = join(dir, "eigen-worktree");
    mkdirSync(join(wt, "sub"), { recursive: true });
    schrijfIdentiteit(staat, realpathSync(wt), ident("a"));
  });

  test("metIdentiteit: het identiteitsbestand wint van een geërfde LAB_AGENT_NAAM; zonder bestand geldt de omgeving", () => {
    const env = { LAB_LEAD_STAAT: staat };
    // een daemon uit een lead-shell: de geërfde naam is die van de lead, het bestand van de thread wint
    expect(metIdentiteit({ ...env, LAB_AGENT_NAAM: "lead-x", LAB_LEAD_NAAM: "lead-y" }, wt, T0)).toMatchObject({ LAB_AGENT_NAAM: "a", LAB_LEAD_NAAM: "lead-x" });
    // zonder bestand voor deze cwd (andere checkout) blijft de omgeving gelden
    expect(metIdentiteit({ ...env, LAB_AGENT_NAAM: "x" }, dir, T0).LAB_AGENT_NAAM).toBe("x");
  });

  test("metIdentiteit: de identiteit van de checkout (ook vanuit een submap)", () => {
    const env = { LAB_LEAD_STAAT: staat };
    expect(metIdentiteit(env, wt, T0)).toMatchObject({ LAB_AGENT_NAAM: "a", LAB_LEAD_NAAM: "lead-x" });
    expect(metIdentiteit(env, join(wt, "sub"), T0).LAB_AGENT_NAAM).toBe("a");
  });

  test("een andere checkout, de hoofdcheckout of een verlopen identiteit krijgt geen naam", () => {
    const env = { LAB_LEAD_STAAT: staat };
    expect(metIdentiteit(env, dir, T0).LAB_AGENT_NAAM).toBeUndefined();
    mkdirSync(join(dir, "andere-worktree"));
    expect(metIdentiteit(env, join(dir, "andere-worktree"), T0).LAB_AGENT_NAAM).toBeUndefined();
    expect(metIdentiteit(env, wt, T0 + 13 * 3600_000).LAB_AGENT_NAAM).toBeUndefined();
  });

  test("echt proces: in de checkout met identiteit werkt list; in een andere map blijft het 'LAB_AGENT_NAAM ontbreekt'", async () => {
    schrijfIdentiteit(staat, realpathSync(wt), ident("a", Date.now())); // het proces gebruikt de echte klok
    const [, goed] = await draaiProces(undefined, [{ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, roep(1, "list")], wt);
    expect(tekstVan(goed)).not.toContain("LAB_AGENT_NAAM ontbreekt");
    const [, fout] = await draaiProces(undefined, [{ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, roep(1, "list")], dir);
    expect(tekstVan(fout)).toContain("LAB_AGENT_NAAM ontbreekt");
  });
});

describe("afgeleide naam voor een Codex-sessie zonder identiteit (CONTRACT.md, Wijziging 27 okt)", () => {
  const tid = "01a17ebd-76bc-7472-a451-ac8ef9f536d4";
  const naam = "codex-ac8ef9f536d4";
  const metaRoep = (id: number, name: string, meta: unknown, args: unknown = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) } });
  const bus1 = () => maakBus({ staat, nu: () => T0, machine: "testmachine" });
  // de eigen sessie staat onder het thread-id in het register (zoals een toekomstige eigen rol dat doet)
  beforeEach(() => schrijfRecord(staat, { ...nieuwRecord(tid, { LAB_AGENT_NAAM: naam }, "/w/eigen", T0), inbound: { standaard: "accept" } } as Rec));

  test("zonder naam, rol en identiteitsbestand komt de afzender uit _meta.threadId", async () => {
    const r = await verwerk(metaRoep(1, "send", { threadId: tid }, { naar: "a", tekst: "hoi" }) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
    expect(tekstVan(r.antwoord)).toMatch(/^afgeleverd /);
    expect(bus1().inbox("a")[0]?.van).toBe(naam);
  });
  test("_meta.sessionId volstaat als threadId ontbreekt", async () => {
    await verwerk(metaRoep(1, "send", { sessionId: tid }, { naar: "a", tekst: "hoi" }) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
    expect(bus1().inbox("a")[0]?.van).toBe(naam);
  });
  test("arguments.threadId (of een _meta in arguments) wordt genegeerd: alleen _meta van de aanroep telt", async () => {
    const r = await verwerk(metaRoep(1, "send", undefined, { naar: "a", tekst: "hoi", threadId: tid, _meta: { threadId: tid } }) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
    expect(r.antwoord?.result as any).toMatchObject({ isError: true });
    expect(bus1().inbox("a")).toHaveLength(0);
  });
  test("zonder (geldig) id weigert de server", async () => {
    for (const meta of [undefined, {}, { threadId: "geen-id" }, { threadId: 5 }]) {
      const r = await verwerk(metaRoep(1, "list", meta) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
      expect(tekstVan(r.antwoord)).toContain("LAB_AGENT_NAAM ontbreekt");
    }
  });
  test("een werker die zijn identiteit kwijt is (afleiden = false) krijgt nooit een afgeleide naam", async () => {
    const r = await verwerk(metaRoep(1, "send", { threadId: tid }, { naar: "a", tekst: "hoi" }) as any, bus1(), { LAB_LEAD_STAAT: staat }, false);
    expect(tekstVan(r.antwoord)).toContain("LAB_AGENT_NAAM ontbreekt");
    expect(bus1().inbox("a")).toHaveLength(0);
  });
  test("echt proces: afleiden alleen zonder LAB_AGENT_NAAM, rol en identiteitsbestand voor de map", async () => {
    const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: {} };
    const [, goed] = await draaiProces(undefined, [init, metaRoep(1, "list", { threadId: tid })], dir);
    expect(tekstVan(goed)).not.toContain("LAB_AGENT_NAAM ontbreekt");
    const wt = join(dir, "werker-wt");
    mkdirSync(wt);
    mkdirSync(join(staat, "identiteit"), { recursive: true, mode: 0o700 });
    await Bun.write(identiteitPad(staat, realpathSync(wt)), "{kapot");
    const [, fout] = await draaiProces(undefined, [init, metaRoep(1, "list", { threadId: tid })], wt);
    expect(tekstVan(fout)).toContain("LAB_AGENT_NAAM ontbreekt");
  });
  test("een levende andere sessie met die naam (een werker die zo heet): geen afgeleide naam, de inbox van die werker blijft dicht", async () => {
    sessie(naam); // zet een registerrecord met die naam (id `id-<naam>`, niet de thread-id)
    await verwerk(metaRoep(1, "send", { threadId: tid }, { naar: "a", tekst: "hoi" }) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
    const r = await verwerk(metaRoep(2, "inbox", { threadId: tid }) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
    expect(tekstVan(r.antwoord)).toContain("LAB_AGENT_NAAM ontbreekt");
    expect(bus1().inbox("a")).toHaveLength(0);
  });
  test("threadId en sessionId allebei aanwezig: gelijk is goed, verschillend weigert", async () => {
    const ander = "01a17ebd-76bc-7472-a451-000000000001";
    const goed = await verwerk(metaRoep(1, "list", { threadId: tid, sessionId: tid }) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
    expect(tekstVan(goed.antwoord)).not.toContain("LAB_AGENT_NAAM ontbreekt");
    const fout = await verwerk(metaRoep(2, "list", { threadId: tid, sessionId: ander }) as any, bus1(), { LAB_LEAD_STAAT: staat }, true);
    expect(tekstVan(fout.antwoord)).toContain("LAB_AGENT_NAAM ontbreekt");
  });
});

describe("de Codex-lead (lead-proef): naam alleen voor de gebonden sessie", () => {
  const gebonden = "01a17ebe-4fe1-79b1-807b-0e8515a20120"; // threadId = sessionId = session_id van de hook (fixture codex-mcp-tools-call.json)
  const ander = "01a17ebd-76bc-7472-a451-ac8ef9f536d4";
  const proef = (extra = {}) => ({ naam: "codex-lead", rol: "lead-proef", lead: "codex-lead", opdracht: "", spawn_id: "lead", ts: T0, ...extra });
  let wt: string;
  beforeEach(() => {
    wt = join(dir, "werkruimte");
    mkdirSync(wt, { recursive: true });
    wt = realpathSync(wt);
  });
  const inbox = async (meta: unknown, env: Record<string, string | undefined> = { LAB_LEAD_STAAT: staat }) =>
    tekstVan((await verwerk({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: {}, ...(meta === undefined ? {} : { _meta: meta }) } } as any, bus(), env, false, wt, T0)).antwoord);

  test("de gebonden sessie spreekt als codex-lead; de server-omgeving zelf kent de naam niet", async () => {
    schrijfIdentiteit(staat, wt, proef({ sessie_id: gebonden }));
    expect(metIdentiteit({ LAB_LEAD_STAAT: staat }, wt, T0).LAB_AGENT_NAAM).toBeUndefined();
    expect(leadProefNaam({ threadId: gebonden, sessionId: gebonden }, { LAB_LEAD_STAAT: staat }, wt, T0)).toBe("codex-lead");
    expect(await inbox({ threadId: gebonden })).not.toContain("LAB_AGENT_NAAM ontbreekt");
  });

  test("een andere sessie, een aanroep zonder _meta of met afwijkende id's krijgt geen naam", async () => {
    schrijfIdentiteit(staat, wt, proef({ sessie_id: gebonden }));
    for (const meta of [{ threadId: ander }, undefined, {}, { threadId: 5 }, { threadId: gebonden, sessionId: ander }]) {
      expect(leadProefNaam(meta, { LAB_LEAD_STAAT: staat }, wt, T0)).toBeNull();
      expect(await inbox(meta)).toContain("LAB_AGENT_NAAM ontbreekt");
    }
  });

  test("een ongebonden identiteit geeft niemand de naam", async () => {
    schrijfIdentiteit(staat, wt, proef());
    expect(leadProefNaam({ threadId: gebonden }, { LAB_LEAD_STAAT: staat }, wt, T0)).toBeNull();
    expect(await inbox({ threadId: gebonden })).toContain("LAB_AGENT_NAAM ontbreekt");
  });

  test("een argument-threadId telt niet; de identiteit wint van een geërfde naam voor de gebonden sessie", async () => {
    schrijfIdentiteit(staat, wt, proef({ sessie_id: gebonden }));
    const r = await verwerk({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: { threadId: gebonden } } } as any, bus(), { LAB_LEAD_STAAT: staat }, false, wt, T0);
    expect(tekstVan(r.antwoord)).toContain("LAB_AGENT_NAAM ontbreekt");
    expect(leadProefNaam({ threadId: gebonden }, { LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: "lead-x" }, wt, T0)).toBe("codex-lead");
  });

  test("een andere rol blijft zoals voorheen: geen leadProef-naam, de identiteit uit metIdentiteit wint", async () => {
    schrijfIdentiteit(staat, wt, { ...proef({ sessie_id: gebonden }), naam: "a", rol: "agent" });
    expect(leadProefNaam({ threadId: gebonden }, { LAB_LEAD_STAAT: staat }, wt, T0)).toBeNull();
    expect(metIdentiteit({ LAB_LEAD_STAAT: staat }, wt, T0).LAB_AGENT_NAAM).toBe("a");
    expect(await inbox({ threadId: gebonden }, metIdentiteit({ LAB_LEAD_STAAT: staat }, wt, T0))).not.toContain("LAB_AGENT_NAAM ontbreekt");
  });

  test("zonder leadProefCwd (oude aanroep) verandert er niets", async () => {
    schrijfIdentiteit(staat, wt, proef({ sessie_id: gebonden }));
    const r = await verwerk({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: {}, _meta: { threadId: gebonden } } } as any, bus(), { LAB_LEAD_STAAT: staat }, false);
    expect(tekstVan(r.antwoord)).toContain("LAB_AGENT_NAAM ontbreekt");
  });
});
