import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAPPEN, schrijfAtomair, type Akkoord, type Uitslag } from "./commando/opslag";
import { verzoekHash } from "./commando/schema";
import {
  AfwijsFout, alleVerzoeken, dien, duurMs, leesArgs, LimietFout, leesVerzoek, MAX_OPEN_PER_INDIENER, MAX_OPEN_TOTAAL, stand, trekIn, uitslagTekst, VERZOEK_GELDIG_S, wacht,
} from "./vraag-brian";

const wortel = mkdtempSync(path.join(tmpdir(), "vraag-brian-"));
afterAll(() => rmSync(wortel, { recursive: true, force: true }));
let teller = 0;
const nieuweMap = () => path.join(wortel, `m${teller++}`);
const ctx = { kloon: "/kloon", test: true };
const NU = Date.parse("2026-10-21T10:00:00Z");
const basisIn = (basis: string, o: Record<string, unknown> = {}) => ({
  basis, ctx, nu: NU, door: "cm-kern", lead: "lead-goldcoast", waarom: "gemerged", soort: "tak-weg", params: { tak: "lead/x" }, ...o,
});
const dien2 = (basis: string, o: Record<string, unknown> = {}) => dien(basisIn(basis, o) as Parameters<typeof dien>[0]);
const uitslagSchrijven = (basis: string, id: string, st: Uitslag["stand"], extra: Partial<Uitslag> = {}) =>
  schrijfAtomair(path.join(basis, MAPPEN.uitslag, `${id}.json`), JSON.stringify({ versie: 1, id, stand: st, staart: [], tijd: new Date(NU).toISOString(), ...extra }));

describe("dien", () => {
  test("legt een verzoek neer (600) en geeft een id van de soort", () => {
    const basis = nieuweMap();
    const r = dien2(basis);
    expect(r.nieuw).toBe(true);
    expect(r.id).toMatch(/^tak-weg-[0-9a-f]{6}$/);
    expect(r.hash).toBe(verzoekHash(r.verzoek, ctx));
    expect(r.verzoek.verlooptS).toBe(Math.floor(NU / 1000) + VERZOEK_GELDIG_S);
    expect(leesVerzoek(basis, r.id)).toEqual(r.verzoek);
    expect(stand(basis, r.id, NU).stand).toBe("open");
  });

  test("--droog schrijft niets", () => {
    const basis = nieuweMap();
    const r = dien2(basis, { droog: true });
    expect(existsSync(path.join(basis, MAPPEN.verzoeken, `${r.id}.json`))).toBe(false);
    expect(alleVerzoeken(basis)).toEqual([]);
  });

  test("hetzelfde open verzoek geeft het bestaande id terug", () => {
    const basis = nieuweMap();
    const a = dien2(basis);
    const b = dien2(basis, { nu: NU + 1000, waarom: "nog eens" });
    expect(b.id).toBe(a.id);
    expect(b.nieuw).toBe(false);
    expect(alleVerzoeken(basis)).toHaveLength(1);
    expect(dien2(basis, { params: { tak: "lead/y" } }).id).not.toBe(a.id);
  });

  test("onbekende soort en kwade params: AfwijsFout en een regel in afgewezen.jsonl", () => {
    const basis = nieuweMap();
    expect(() => dien2(basis, { soort: "uitrol", params: {} })).toThrow(AfwijsFout);
    expect(() => dien2(basis, { params: { tak: "main" } })).toThrow(AfwijsFout);
    expect(() => dien2(basis, { params: { tak: "a b" } })).toThrow(AfwijsFout);
    expect(() => dien2(basis, { waarom: "x".repeat(501) })).toThrow(AfwijsFout);
    const regels = readFileSync(path.join(basis, "afgewezen.jsonl"), "utf8").trim().split("\n").map((r) => JSON.parse(r));
    expect(regels).toHaveLength(4);
    expect(regels[0]).toMatchObject({ t: NU, door: "cm-kern", lead: "lead-goldcoast" });
    expect(alleVerzoeken(basis)).toEqual([]);
  });

  test("proef-echo bestaat alleen in teststand", () => {
    const basis = nieuweMap();
    expect(dien2(basis, { soort: "proef-echo", params: { tekst: "hoi" } }).id).toMatch(/^proef-echo-/);
    expect(() => dien2(basis, { ctx: { ...ctx, test: false }, soort: "proef-echo", params: { tekst: "hoi" } })).toThrow(AfwijsFout);
  });

  test("limiet: 5 open per indiener", () => {
    const basis = nieuweMap();
    for (let i = 0; i < MAX_OPEN_PER_INDIENER; i++) dien2(basis, { params: { tak: `lead/t${i}` } });
    expect(() => dien2(basis, { params: { tak: "lead/te-veel" } })).toThrow(LimietFout);
    expect(() => dien2(basis, { door: "ander", params: { tak: "lead/te-veel" } })).not.toThrow();
  });

  test("limiet: 20 open in totaal", () => {
    const basis = nieuweMap();
    for (let i = 0; i < MAX_OPEN_TOTAAL; i++) dien2(basis, { door: `agent-${i}`, params: { tak: `lead/t${i}` } });
    expect(() => dien2(basis, { door: "agent-nieuw", params: { tak: "lead/laatste" } })).toThrow(/te veel: er staan al 20/);
  });

  test("een afgehandeld, ingetrokken of verlopen verzoek telt niet als open", () => {
    const basis = nieuweMap();
    const ids = Array.from({ length: MAX_OPEN_PER_INDIENER }, (_, i) => dien2(basis, { params: { tak: `lead/t${i}` } }).id);
    uitslagSchrijven(basis, ids[0]!, "klaar");
    expect(() => dien2(basis, { params: { tak: "lead/nieuw" } })).not.toThrow();
    expect(() => dien2(basis, { nu: NU + (VERZOEK_GELDIG_S + 1) * 1000, params: { tak: "lead/later" } })).not.toThrow();
  });

  test("limiet: maxPerDag per soort, in een rollend venster van 24 uur", () => {
    const basis = nieuweMap();
    const max = 30;
    for (let i = 0; i < max; i++) {
      const r = dien2(basis, { door: `agent-${i}`, params: { tak: `lead/t${i}` } });
      uitslagSchrijven(basis, r.id, "klaar");
    }
    expect(() => dien2(basis, { door: "nog-een", params: { tak: "lead/een-te-veel" } })).toThrow(/gevraagd in 24 uur/);
    expect(() => dien2(basis, { nu: NU + 25 * 3600_000, door: "nog-een", params: { tak: "lead/morgen" } })).not.toThrow();
  });
});

describe("stand", () => {
  test("open → bezig (akkoord) → uitslag; verlopen na 24 uur", () => {
    const basis = nieuweMap();
    const r = dien2(basis);
    expect(stand(basis, r.id, NU + (VERZOEK_GELDIG_S - 1) * 1000).stand).toBe("open");
    expect(stand(basis, r.id, NU + VERZOEK_GELDIG_S * 1000).stand).toBe("verlopen");
    const akkoord: Akkoord = {
      versie: 1, id: r.id, hash: r.hash, nonce: "n", verlooptS: 1, apparaat: "tel", tijd: "2026-10-21T10:01:00Z",
      assertion: { credentialId: "c", authenticatorData: "a", clientDataJSON: "d", signature: "s" },
    };
    schrijfAtomair(path.join(basis, MAPPEN.akkoord, `${r.id}.json`), JSON.stringify(akkoord));
    expect(stand(basis, r.id, NU).stand).toBe("bezig");
    uitslagSchrijven(basis, r.id, "klaar", { exit: 0, staart: ["ok"] });
    expect(stand(basis, r.id, NU)).toMatchObject({ stand: "klaar", uitslag: { exit: 0, staart: ["ok"] } });
  });

  test("een onbekend id is open, nooit een fout", () => {
    expect(stand(nieuweMap(), "bestaat-niet", NU).stand).toBe("open");
  });

  test("uitslagTekst toont stand, exit, reden en staart", () => {
    expect(uitslagTekst("x-1", { stand: "fout", uitslag: { versie: 1, id: "x-1", stand: "fout", exit: 1, staart: ["a", "b"], reden: "kapot", tijd: "t" } })).toBe("x-1: fout (exit 1) – kapot\na\nb");
    expect(uitslagTekst("x-1", { stand: "open" })).toBe("x-1: open");
  });
});

describe("trekIn", () => {
  test("alleen eigen, alleen zolang open; daarna kan niets het nog uitvoeren", () => {
    const basis = nieuweMap();
    const r = dien2(basis);
    expect(() => trekIn(basis, r.id, "iemand-anders", NU)).toThrow("is van cm-kern");
    expect(() => trekIn(basis, "bestaat-niet", "cm-kern", NU)).toThrow("onbekend");
    trekIn(basis, r.id, "cm-kern", NU);
    expect(stand(basis, r.id, NU)).toMatchObject({ stand: "geweigerd", uitslag: { reden: "ingetrokken door cm-kern" } });
    expect(() => trekIn(basis, r.id, "cm-kern", NU)).toThrow("geweigerd");
    expect(() => dien2(basis)).not.toThrow();
  });

  test("niet meer na een akkoord", () => {
    const basis = nieuweMap();
    const r = dien2(basis);
    schrijfAtomair(path.join(basis, MAPPEN.akkoord, `${r.id}.json`), JSON.stringify({ id: r.id }));
    expect(() => trekIn(basis, r.id, "cm-kern", NU)).toThrow("bezig");
  });
});

describe("wacht", () => {
  test("wacht op een nep-klok tot de uitslag er is", async () => {
    const basis = nieuweMap();
    const r = dien2(basis);
    let klok = NU;
    let slapen = 0;
    const slaap = async (ms: number) => {
      klok += ms;
      if (++slapen === 3) uitslagSchrijven(basis, r.id, "klaar", { exit: 0 });
    };
    const uit = await wacht(basis, r.id, 60_000, () => klok, slaap);
    expect(uit).toMatchObject({ stand: "klaar", teLaat: false });
    expect(slapen).toBe(3);
  });

  test("geeft op na de maximale tijd", async () => {
    const basis = nieuweMap();
    const r = dien2(basis);
    let klok = NU;
    const uit = await wacht(basis, r.id, 10_000, () => klok, async (ms) => void (klok += ms));
    expect(uit).toMatchObject({ stand: "open", teLaat: true });
  });

  test("een geweigerd verzoek is meteen een eindstand", async () => {
    const basis = nieuweMap();
    const r = dien2(basis);
    uitslagSchrijven(basis, r.id, "geweigerd");
    expect((await wacht(basis, r.id, 1000, () => NU, async () => {})).stand).toBe("geweigerd");
  });
});

describe("argumenten", () => {
  test("leesArgs: positioneel, --naam waarde, vlaggen en alles na --", () => {
    expect(leesArgs(["tak-weg", "--tak", "lead/x", "--waarom", "w", "--droog"])).toEqual({ pos: ["tak-weg"], o: { tak: "lead/x", waarom: "w", droog: true }, na: null });
    expect(leesArgs(["--waarom", "w", "--", "bash", "--verwijder", "x"])).toEqual({ pos: [], o: { waarom: "w" }, na: ["bash", "--verwijder", "x"] });
    expect(() => leesArgs(["--tak"])).toThrow("mist een waarde");
  });

  test("duurMs", () => {
    expect(duurMs("30m")).toBe(1_800_000);
    expect(duurMs("45s")).toBe(45_000);
    expect(duurMs("2h")).toBe(7_200_000);
    expect(() => duurMs("lang")).toThrow("ongeldige duur");
  });
});

describe("CLI", () => {
  const SCRIPT = path.join(import.meta.dir, "vraag-brian.ts");
  const draai = (basis: string, args: string[], env: Record<string, string> = {}) => {
    const schoon: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("LAB_") && !k.startsWith("TMUX")) schoon[k] = v;
    const p = Bun.spawnSync(["bun", SCRIPT, ...args], {
      cwd: wortel, stdout: "pipe", stderr: "pipe",
      env: { ...schoon, LAB_COMMANDO: basis, LAB_AGENT_ROL: "sub", LAB_AGENT_NAAM: "cm-kern", LAB_LEAD_NAAM: "lead-goldcoast", ...env },
    });
    return { code: p.exitCode, uit: p.stdout.toString(), fout: p.stderr.toString() };
  };

  test("indienen geeft het id op stdout, exit 0", () => {
    const basis = nieuweMap();
    const r = draai(basis, ["tak-weg", "--tak", "lead/x", "--waarom", "gemerged"]);
    expect(r.code).toBe(0);
    const id = r.uit.trim();
    expect(leesVerzoek(basis, id)).toMatchObject({ soort: "tak-weg", params: { tak: "lead/x" }, door: "cm-kern", lead: "lead-goldcoast", waarom: "gemerged" });
    expect(draai(basis, ["lees", id]).uit.trim()).toBe(`${id}: open`);
    expect(JSON.parse(draai(basis, ["lees", id, "--json"]).uit)).toMatchObject({ id, stand: "open" });
    expect(draai(basis, ["trek-in", id]).uit.trim()).toBe(`${id}: ingetrokken`);
  });

  test("de lead zelf: door en lead zijn haar naam", () => {
    const basis = nieuweMap();
    const r = draai(basis, ["tak-weg", "--tak", "lead/x", "--waarom", "w"], { LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: "lead-goldcoast", LAB_LEAD_NAAM: "" });
    expect(r.code).toBe(0);
    expect(leesVerzoek(basis, r.uit.trim())).toMatchObject({ door: "lead-goldcoast", lead: "lead-goldcoast" });
  });

  test("zonder LAB_AGENT_ROL weigert indienen en intrekken, lezen mag", () => {
    const basis = nieuweMap();
    expect(draai(basis, ["tak-weg", "--tak", "lead/x", "--waarom", "w"], { LAB_AGENT_ROL: "" }).code).toBe(1);
    expect(draai(basis, ["trek-in", "x-123"], { LAB_AGENT_ROL: "" }).code).toBe(1);
    expect(draai(basis, ["lees", "x-123"], { LAB_AGENT_ROL: "" }).code).toBe(0);
    expect(alleVerzoeken(basis)).toEqual([]);
  });

  test("--waarom is verplicht", () => {
    const r = draai(nieuweMap(), ["tak-weg", "--tak", "lead/x"]);
    expect(r.code).toBe(1);
    expect(r.fout).toContain("--waarom");
  });

  test("exit 2 bij een onbekende soort of kwade param, met de lijst soorten en afgewezen.jsonl", () => {
    const basis = nieuweMap();
    const a = draai(basis, ["uitrol", "--waarom", "w"]);
    expect(a.code).toBe(2);
    expect(a.fout).toContain("tak-weg");
    expect(draai(basis, ["tak-weg", "--tak", "main", "--waarom", "w"]).code).toBe(2);
    expect(readFileSync(path.join(basis, "afgewezen.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("exit 3 bij een limiet", () => {
    const basis = nieuweMap();
    for (let i = 0; i < MAX_OPEN_PER_INDIENER; i++) expect(draai(basis, ["tak-weg", "--tak", `lead/t${i}`, "--waarom", "w"]).code).toBe(0);
    expect(draai(basis, ["tak-weg", "--tak", "lead/te-veel", "--waarom", "w"]).code).toBe(3);
  });

  test("-- <argv>: herkend als soort, anders exit 2 en afgewezen.jsonl", () => {
    const basis = nieuweMap();
    const ok = draai(basis, ["--waarom", "w", "--", "bash", "scripts/lead/push.sh", "--verwijder", "lead/x"]);
    expect(ok.code).toBe(0);
    expect(leesVerzoek(basis, ok.uit.trim())).toMatchObject({ soort: "tak-weg", params: { tak: "lead/x" } });
    const fout = draai(basis, ["--waarom", "w", "--", "sh", "-c", "git push origin :lead/x"]);
    expect(fout.code).toBe(2);
    expect(JSON.parse(readFileSync(path.join(basis, "afgewezen.jsonl"), "utf8").trim()).wat).toEqual({ argv: ["sh", "-c", "git push origin :lead/x"] });
    expect(alleVerzoeken(basis)).toHaveLength(1);
  });

  test("--droog toont verzoek, hash, kaarttekst en argv, en schrijft niets", () => {
    const basis = nieuweMap();
    const r = draai(basis, ["tak-weg", "--tak", "lead/x", "--waarom", "w", "--droog"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.uit);
    expect(j.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(j.argv).toEqual(["bash", "scripts/lead/push.sh", "--verwijder", "lead/x"]);
    expect(j.kaart).toContain("lead/x");
    expect(j.risico).toBe("midden");
    expect(existsSync(basis)).toBe(false);
  });

  test("soorten toont de regels per param", () => {
    const r = draai(nieuweMap(), ["soorten"], { LAB_AGENT_ROL: "" });
    expect(r.code).toBe(0);
    expect(r.uit).toContain("tak-weg");
    expect(r.uit).toContain("--https");
    expect(r.uit).toContain("proef-echo");
  });

  test("in de livestand (TMUX_PWA_LIVE) bestaat proef-echo niet", () => {
    const r = draai(nieuweMap(), ["soorten"], { LAB_AGENT_ROL: "", TMUX_PWA_LIVE: "1" });
    expect(r.uit).not.toContain("proef-echo");
  });
});
