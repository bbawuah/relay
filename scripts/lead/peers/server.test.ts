import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Rec, nieuwRecord, schrijfRecord } from "../hooks/register";
import { maakBus } from "./bus";
import { verwerk } from "./server";
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
async function draaiProces(naam: string | undefined, regels: unknown[]): Promise<any[]> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_") && k !== "LAB_AGENT_NAAM") env[k] = v;
  env.LAB_LEAD_STAAT = staat;
  if (naam) env.LAB_AGENT_NAAM = naam;
  const p = Bun.spawn(["bun", SERVER], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
    expect(tekstVan(s[0])).toMatch(/^afgeleverd [0-9a-f-]{36}, wek: nee \(geen\)$/);
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

  test("zonder LAB_AGENT_NAAM geven send, inbox en notify_when_idle een duidelijke fout; list werkt", async () => {
    const r = await draaiProces(undefined, [roep(1, "send", { naar: "b", tekst: "x" }), roep(2, "inbox"), roep(3, "notify_when_idle", { naam: "b" }), roep(4, "list")]);
    for (const x of r.slice(0, 3)) {
      expect(x.result.isError).toBe(true);
      expect(tekstVan(x)).toContain("LAB_AGENT_NAAM");
    }
    expect(r[3].result.isError).toBeUndefined();
  });

  test("een afzender die niet in het register staat krijgt geen_afzender", async () => {
    const r = await draaiProces("spook", [roep(1, "send", { naar: "b", tekst: "x" })]);
    expect(tekstVan(r[0])).toContain("geen_afzender");
  });
});

describe("verwerk", () => {
  test("inbox ackt pas na `daarna`, niet bij het antwoord zelf", async () => {
    await bus().send("a", "b", "hoi");
    const v = await verwerk(roep(1, "inbox") as any, bus(), { LAB_AGENT_NAAM: "b" });
    expect(bus().inbox("b")).toHaveLength(1);
    v.daarna!();
    expect(bus().inbox("b")).toEqual([]);
  });

  test("een gooiende bus wordt een tool-fout, geen crash", async () => {
    const kapot = { list: () => { throw new Error("stuk"); } } as any;
    const v = await verwerk(roep(1, "list") as any, kapot, {});
    expect((v.antwoord!.result as any).isError).toBe(true);
  });
});
