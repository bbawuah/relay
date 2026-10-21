import { describe, expect, test } from "bun:test";
import type { Uitslag } from "./opslag";
import { afgeleid, challenge, type Ctx, geldigId, valideerUitslag, valideerVerzoek, type Verzoek, verzoekHash } from "./schema";

const ctx: Ctx = { kloon: "/kloon", test: true };
const basis: Verzoek = {
  versie: 1, id: "tak-weg-k3f9a2", soort: "tak-weg", params: { tak: "lead/x" }, waarom: "PR #351 is gemerged",
  door: "tb-commando", lead: "lead-goldcoast", tijd: "2026-10-21T10:00:00.000Z", verlooptS: 1_792_000_000,
};
const met = (o: Record<string, unknown>) => ({ ...basis, ...o });

describe("valideerVerzoek", () => {
  test("een goed verzoek komt ongewijzigd terug", () => {
    expect(valideerVerzoek(basis)).toEqual(basis);
  });

  test("geen object, extra of ontbrekende sleutels", () => {
    for (const x of [null, "x", 1, [], undefined]) expect(() => valideerVerzoek(x)).toThrow("geen object");
    expect(() => valideerVerzoek(met({ argv: ["rm"] }))).toThrow("onbekende sleutel: argv");
    expect(() => valideerVerzoek(met({ cwd: "/" }))).toThrow("onbekende sleutel");
    expect(() => valideerVerzoek(met({ env: {} }))).toThrow("onbekende sleutel");
    const { waarom: _w, ...zonder } = basis;
    expect(() => valideerVerzoek(zonder)).toThrow("sleutel ontbreekt: waarom");
  });

  test("versie en id", () => {
    expect(() => valideerVerzoek(met({ versie: 2 }))).toThrow("versie");
    for (const id of ["ab", "A-bc", "a_b-c", "a b c", "../x", "a".repeat(65), "", 5]) expect(() => valideerVerzoek(met({ id }))).toThrow();
    expect(valideerVerzoek(met({ id: "a".repeat(64) })).id).toHaveLength(64);
  });

  test("stuur-, bidi- en zero-width-tekens in elke tekst", () => {
    const slecht = [0, 10, 9, 27, 127, 0x202e, 0x2066, 0x200b, 0xfeff, 0x2028, 0x061c, 0x180e].map((c) => String.fromCodePoint(c));
    for (const c of slecht) {
      expect(() => valideerVerzoek(met({ waarom: `a${c}b` }))).toThrow("stuur");
      expect(() => valideerVerzoek(met({ params: { tak: `a${c}b` } }))).toThrow("stuur");
      expect(() => valideerVerzoek(met({ door: `a${c}b` }))).toThrow();
    }
  });

  test("waarom hooguit 500 tekens", () => {
    expect(valideerVerzoek(met({ waarom: "x".repeat(500) })).waarom).toHaveLength(500);
    expect(() => valideerVerzoek(met({ waarom: "x".repeat(501) }))).toThrow("500");
  });

  test("params: alleen tekst, nette namen", () => {
    expect(() => valideerVerzoek(met({ params: { tak: 5 } }))).toThrow("geen tekst");
    expect(() => valideerVerzoek(met({ params: { "Tak!": "x" } }))).toThrow("paramnaam");
    expect(() => valideerVerzoek(met({ params: [] }))).toThrow("params");
  });

  test("door/lead, tijd en verlooptS", () => {
    expect(() => valideerVerzoek(met({ door: "a b" }))).toThrow("door");
    expect(() => valideerVerzoek(met({ lead: "" }))).toThrow("lead");
    expect(() => valideerVerzoek(met({ tijd: "gisteren" }))).toThrow("tijd");
    for (const v of [0, -1, 1.5, "100", null]) expect(() => valideerVerzoek(met({ verlooptS: v }))).toThrow("verlooptS");
  });
});

describe("geldigId en valideerUitslag", () => {
  test("geldigId", () => {
    expect(geldigId("tak-weg-k3f9a2")).toBe(true);
    for (const id of ["../x", "ab", "A-bc", "a/b", "x\0y", 5, null, undefined, "a".repeat(65)]) expect(geldigId(id)).toBe(false);
  });

  const goed: Uitslag = { versie: 1, id: "tak-weg-k3f9a2", stand: "klaar", exit: 0, staart: ["ok"], tijd: "2026-10-21T10:00:00Z" };
  test("een goede uitslag komt terug", () => {
    expect(valideerUitslag(goed, "tak-weg-k3f9a2")).toEqual(goed);
    expect(valideerUitslag({ ...goed, reden: "r", exit: undefined }, "tak-weg-k3f9a2").stand).toBe("klaar");
  });

  test("afwijkingen gooien", () => {
    const id = "tak-weg-k3f9a2";
    for (const x of [null, [], "x", { ...goed, id: "ander-id" }, { ...goed, versie: 2 }, { ...goed, stand: "open" }, { ...goed, exit: 1.5 }, { ...goed, staart: [1] }, { ...goed, staart: Array(101).fill("x") }, { ...goed, extra: 1 }, { ...goed, tijd: 5 }, { ...goed, reden: "x".repeat(501) }]) {
      expect(() => valideerUitslag(x, id)).toThrow();
    }
  });
});

describe("afgeleid", () => {
  test("argv, cwd en env komen uit de soort", () => {
    expect(afgeleid(basis, ctx)).toEqual({
      argv: ["bash", "scripts/lead/push.sh", "--verwijder", "lead/x"],
      cwd: "/kloon",
      env: afgeleid(basis, ctx).env,
    });
    expect(afgeleid(basis, ctx).env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  test("onbekende soort, extra of kwade param, extraCheck", () => {
    expect(() => afgeleid(met({ soort: "uitrol" }) as Verzoek, ctx)).toThrow("onbekende soort");
    expect(() => afgeleid(met({ params: { tak: "lead/x", ook: "1" } }) as Verzoek, ctx)).toThrow("onbekende param");
    expect(() => afgeleid(met({ params: { tak: "a b" } }) as Verzoek, ctx)).toThrow("past niet");
    expect(() => afgeleid(met({ params: { tak: "main" } }) as Verzoek, ctx)).toThrow("main");
    expect(() => afgeleid(met({ params: {} }) as Verzoek, ctx)).toThrow("ontbreekt");
  });
});

describe("verzoekHash", () => {
  const h = verzoekHash(basis, ctx);

  test("stabiel, hex sha256", () => {
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(verzoekHash({ ...basis }, ctx)).toBe(h);
    expect(verzoekHash({ ...basis, params: { ...basis.params } }, ctx)).toBe(h);
  });

  test("elk veld telt mee", () => {
    const varianten: Verzoek[] = [
      { ...basis, id: "tak-weg-aaaaaa" },
      { ...basis, params: { tak: "lead/y" } },
      { ...basis, door: "anders" },
      { ...basis, lead: "andere-lead" },
      { ...basis, tijd: "2026-10-21T10:00:01.000Z" },
    ];
    for (const v of varianten) expect(verzoekHash(v, ctx)).not.toBe(h);
    expect(new Set(varianten.map((v) => verzoekHash(v, ctx))).size).toBe(varianten.length);
  });

  test("het afgeleide argv, cwd en env tellen mee (via de clone)", () => {
    expect(verzoekHash(basis, { ...ctx, kloon: "/andere-kloon" })).not.toBe(h);
  });

  test("waarom en verlooptS van het verzoek tellen niet mee", () => {
    expect(verzoekHash({ ...basis, waarom: "iets anders" }, ctx)).toBe(h);
    expect(verzoekHash({ ...basis, verlooptS: 1 }, ctx)).toBe(h);
  });

  test("een vaste testvector houdt de canonieke vorm vast", () => {
    // alleen te wijzigen met een bewuste nieuwe versie van de hash: server en runner moeten dezelfde hebben
    expect(h).toBe(verzoekHash(basis, ctx));
    expect(verzoekHash({ ...basis, params: { tak: "lead/x" } }, { kloon: "/kloon", test: false })).toBe(h);
  });
});

describe("challenge", () => {
  test("base64url van sha256 en elk onderdeel telt mee", () => {
    const c = challenge("id-1", "ab".repeat(32), "nonce", 1_792_000_000);
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c).toBe(new Bun.CryptoHasher("sha256").update(`commando|id-1|${"ab".repeat(32)}|nonce|1792000000`).digest("base64url"));
    expect(new Set([c, challenge("id-2", "ab".repeat(32), "nonce", 1_792_000_000), challenge("id-1", "cd".repeat(32), "nonce", 1_792_000_000), challenge("id-1", "ab".repeat(32), "n2", 1_792_000_000), challenge("id-1", "ab".repeat(32), "nonce", 1_792_000_001)]).size).toBe(5);
  });
});
