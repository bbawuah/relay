import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Rec, nieuwRecord, schrijfRecord } from "../hooks/register";
import { maakBus } from "./bus";
import { draai } from "./cli";
import { toon } from "./types";

// Tijdelijke staatmap; de echte ~/.local/state/lab-lead blijft ongemoeid.

const T0 = 1_700_000_000_000;
let dir: string;
let staat: string;
let klok: number;

const bus = () => maakBus({ staat, nu: () => klok, machine: "testmachine" });
const env = (naam: string) => ({ LAB_AGENT_NAAM: naam, LAB_LEAD_STAAT: staat });
function sessie(naam: string, lead = "", extra: Partial<Rec> & Record<string, unknown> = {}): void {
  schrijfRecord(staat, { ...nieuwRecord(`id-${naam}`, { LAB_AGENT_NAAM: naam, LAB_LEAD_NAAM: lead }, `/w/${naam}`, T0), inbound: { standaard: "accept" }, ...extra } as Rec);
}
const cli = (naam: string, ...args: string[]) => draai(args, env(naam), bus());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-peers-cli-"));
  staat = join(dir, "staat");
  klok = T0;
  sessie("a");
  sessie("b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cli send", () => {
  test("verstuurt en meldt status en id; de ontvanger heeft het bericht", async () => {
    const r = await cli("a", "send", "b", "hoi daar");
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/^afgeleverd [0-9a-f-]{36}, wek: nee \(geen\)\n$/);
    expect(bus().inbox("b").map((e) => [e.van, e.tekst])).toEqual([["a", "hoi daar"]]);
  });

  test("tekst `-` leest stdin (meerdere regels, laatste newline eraf)", async () => {
    const r = await draai(["send", "b", "-"], env("a"), bus(), async () => "regel 1\nregel 2\n");
    expect(r.code).toBe(0);
    expect(bus().inbox("b")[0]!.tekst).toBe("regel 1\nregel 2");
  });

  test("--draad en --antwoord-op worden doorgegeven", async () => {
    await cli("a", "send", "b", "vraag", "--draad", "d1");
    const vraag = bus().inbox("b")[0]!;
    klok += 10;
    const r = await cli("b", "send", "a", "antwoord", "--antwoord-op", vraag.id);
    expect(r.code).toBe(0);
    expect(bus().inbox("a")[0]).toMatchObject({ draad: "d1", hop: 2, antwoord_op: vraag.id });
  });

  test("een geweigerde send geeft code 1 met reden op stderr", async () => {
    const r = await cli("a", "send", "niemand", "hoi");
    expect(r).toMatchObject({ code: 1, uit: "" });
    expect(r.fout).toContain("onbekend");
  });

  test("zonder LAB_AGENT_NAAM: duidelijke fout, niets verstuurd", async () => {
    for (const args of [["send", "b", "x"], ["inbox"], ["notify-when-idle", "b"]]) {
      const r = await draai(args, { LAB_LEAD_STAAT: staat }, bus());
      expect(r.code).toBe(1);
      expect(r.fout).toContain("LAB_AGENT_NAAM");
    }
    expect(bus().inbox("b")).toEqual([]);
  });

  test("ontbrekende argumenten of waarden geven het gebruik", async () => {
    for (const args of [["send"], ["send", "b"], ["send", "b", "x", "extra"], ["send", "b", "x", "--draad"]]) {
      const r = await cli("a", ...args);
      expect(r.code).toBe(1);
    }
    expect((await cli("a", "send", "b")).fout).toContain("Gebruik");
  });
});

describe("cli inbox", () => {
  test("toont kop(van, herkomst) en tekst per bericht en ackt", async () => {
    await cli("a", "send", "b", "eerste");
    klok += 10;
    await cli("a", "send", "b", "tweede");
    const eerste = bus().inbox("b")[0]!;
    const r = await cli("b", "inbox");
    expect(r.code).toBe(0);
    expect(r.uit).toContain(toon(eerste));
    expect(r.uit.indexOf("eerste")).toBeLessThan(r.uit.indexOf("tweede"));
    expect((await cli("b", "inbox")).uit).toBe("Geen berichten.\n");
  });

  test("een extern bericht krijgt de waarschuwingskop", async () => {
    sessie("x", "", { herkomst: "extern" });
    await cli("x", "send", "b", "lees dit");
    const e = bus().inbox("b")[0]!;
    const r = await cli("b", "inbox");
    expect(r.uit).toContain(toon(e));
    expect(r.uit).toContain("onbetrouwbare inhoud");
  });

  test("--niet-acken laat de berichten staan", async () => {
    await cli("a", "send", "b", "blijf");
    expect((await cli("b", "inbox", "--niet-acken")).uit).toContain("blijf");
    expect((await cli("b", "inbox")).uit).toContain("blijf");
    expect((await cli("b", "inbox")).uit).toBe("Geen berichten.\n");
  });

  test("het id en de draad staan erbij, zodat een antwoord kan verwijzen", async () => {
    await cli("a", "send", "b", "vraag");
    const e = bus().inbox("b")[0]!;
    expect((await cli("b", "inbox", "--niet-acken")).uit).toContain(`id ${e.id} · draad ${e.draad}`);
  });
});

describe("cli list, notify-when-idle, vasthouden, vrijgeven", () => {
  test("list toont tekst en --json de Peer-objecten", async () => {
    const t = await cli("a", "list");
    expect(t.uit).toContain("a\tclaude/tui\tbezig");
    expect(t.uit).toContain("b\tclaude/tui");
    const j = JSON.parse((await cli("a", "list", "--json")).uit);
    expect(j.map((p: { naam: string }) => p.naam).sort()).toEqual(["a", "b"]);
    expect(j[0]).toHaveProperty("machine", "testmachine");
  });

  test("notify-when-idle: na idleGemeld komt er één idle-bericht", async () => {
    const r = await cli("a", "notify-when-idle", "b");
    expect(r.code).toBe(0);
    await bus().idleGemeld("b", "klaar");
    const i = await cli("a", "inbox");
    expect(i.uit).toContain("b is klaar");
  });

  test("vasthouden toont en vrijgeven levert af", async () => {
    sessie("h", "", { inbound: { standaard: "hold" } });
    await cli("a", "send", "h", "wacht");
    expect((await cli("a", "inbox")).uit).toBe("Geen berichten.\n");
    const v = await cli("lead", "vasthouden", "h");
    expect(v.uit).toContain("wacht");
    expect((await cli("lead", "vrijgeven", "h")).uit).toBe("1 bericht vrijgegeven aan h.\n");
    expect((await cli("h", "inbox")).uit).toContain("wacht");
    expect((await cli("lead", "vasthouden", "h")).uit).toBe("Niets vastgehouden.\n");
    expect((await cli("lead", "vrijgeven", "h")).uit).toBe("0 berichten vrijgegeven aan h.\n");
  });

  test("onbekend commando geeft het gebruik", async () => {
    const r = await cli("a", "wat");
    expect(r.code).toBe(1);
    expect(r.fout).toContain("Gebruik");
  });
});

describe("cli als proces", () => {
  test("bun cli.ts send en inbox tegen een tijdelijke staatmap, exitcode en uitvoer", async () => {
    const pad = join(import.meta.dir, "cli.ts");
    const draaiProces = async (naam: string, ...args: string[]) => {
      const p = Bun.spawn(["bun", pad, ...args], { env: { PATH: process.env.PATH!, HOME: dir, LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: naam }, stdout: "pipe", stderr: "pipe" });
      const [uit, fout, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { uit, fout, code };
    };
    const s = await draaiProces("a", "send", "b", "via proces");
    expect(s.code).toBe(0);
    const i = await draaiProces("b", "inbox");
    expect(i.code).toBe(0);
    expect(i.uit).toContain("via proces");
    const f = await draaiProces("a", "send", "niemand", "x");
    expect(f.code).toBe(1);
    expect(f.fout).toContain("onbekend");
  });
});
