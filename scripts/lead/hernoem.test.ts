import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hernoem } from "./hernoem";
import { type Rec, dubbeleLeads, leesRecord, nieuwRecord, schrijfRecord } from "./hooks/register";

let dir: string;
let staat: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-hernoem-"));
  staat = join(dir, "staat");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const maak = (id: string, naam: string, rol: string, lead: string, extra: Partial<Rec> = {}) => {
  const r: Rec = { ...nieuwRecord(id, { LAB_AGENT_NAAM: naam, LAB_AGENT_ROL: rol, LAB_LEAD_NAAM: lead }, "/w", 1), ...extra };
  schrijfRecord(staat, r);
};
const lead = (id: string) => leesRecord(staat, id)?.lead;
const o = (extra: Record<string, unknown> = {}) => ({ sessie: "L1", naam: "lead-a", volgers: [] as string[], droog: false, ...extra });

describe("hernoem.ts", () => {
  beforeEach(() => {
    maak("L1", "lead", "lead", "");
    maak("L2", "lead", "lead", "");
    maak("w1", "w1", "agent", "lead");
    maak("w2", "w2", "agent", "lead");
    maak("w3", "w3", "agent", "lead", { toestand: "weg" });
    maak("sub1", "w1", "agent", "lead", { soort: "subagent", ouder: "w1" });
  });

  test("hernoemt alleen het genoemde lead-record en zet alleen genoemde volgers om, met subagents", () => {
    const u = hernoem(staat, o({ volgers: ["w1"] }), null);
    expect(u.code).toBe(0);
    expect(leesRecord(staat, "L1")?.naam).toBe("lead-a");
    expect(leesRecord(staat, "L2")?.naam).toBe("lead");
    expect(lead("w1")).toBe("lead-a");
    expect(lead("sub1")).toBe("lead-a");
    expect(lead("w2")).toBe("lead"); // niet genoemd: blijft
  });

  test("zonder --volgers verandert geen enkele volger", () => {
    expect(hernoem(staat, o(), null).code).toBe(0);
    for (const id of ["w1", "w2", "w3", "sub1"]) expect(lead(id)).toBe("lead");
  });

  test("--droog schrijft niets", () => {
    const u = hernoem(staat, o({ volgers: ["w1"], droog: true }), null);
    expect(u.code).toBe(0);
    expect(u.uit.join("\n")).toContain("lead -> lead-a");
    expect(leesRecord(staat, "L1")?.naam).toBe("lead");
    expect(lead("w1")).toBe("lead");
  });

  test("weigert onbekende of dode volger (niets geschreven), dubbele naam en slechte naam", () => {
    expect(hernoem(staat, o({ volgers: ["w1", "w3"] }), null).code).toBe(1);
    expect(hernoem(staat, o({ volgers: ["nietbestaand"] }), null).code).toBe(1);
    expect(leesRecord(staat, "L1")?.naam).toBe("lead");
    expect(lead("w1")).toBe("lead");
    expect(hernoem(staat, o({ naam: "lead" }), null).fout.join()).toMatch(/al een lead/);
    expect(hernoem(staat, o({ naam: "a b" }), null).code).toBe(1);
    expect(hernoem(staat, o({ sessie: "zzz" }), null).code).toBe(1);
  });
});

describe("levende leads: hergebruikte panes", () => {
  test("per pane telt alleen het jongste record; oud record in dezelfde pane is niet dubbel", () => {
    maak("oud", "lead", "lead", "", { pane: "%0", start: 1 });
    maak("nieuw", "lead", "lead", "", { pane: "%0", start: 5 });
    maak("andere", "lead", "lead", "", { pane: "%12", start: 3 });
    const panes = new Set(["%0", "%12"]);
    // de jongste in %0 hernoemen: alleen "andere" is een echte dubbel, "oud" niet
    expect(dubbeleLeads(staat, "lead", "nieuw", panes).map((r) => r.id)).toEqual(["andere"]);
    // na hernoem van "nieuw" is "lead" niet meer dubbel voor "andere"
    maak("nieuw", "lead-eagle", "lead", "", { pane: "%0", start: 5 });
    expect(dubbeleLeads(staat, "lead", "andere", panes)).toEqual([]);
  });
});
