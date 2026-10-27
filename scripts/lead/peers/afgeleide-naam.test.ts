import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heeftIdentiteitsbestand, identiteitPad, nieuwRecord, schrijfRecord } from "../hooks/register";
import { afgeleideNaam, botstMetLevendeSessie, magAfleiden } from "./afgeleide-naam";
import { geldigeNaam } from "./bus";

let dir: string;
let staat: string;
let map: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peers-afgeleid-")));
  staat = join(dir, "staat");
  map = join(dir, "map");
  mkdirSync(map);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("afgeleideNaam", () => {
  test("de laatste 12 hexcijfers van een uuid, zonder streepjes, met het voorvoegsel codex-", () => {
    expect(afgeleideNaam("01a17ebd-76bc-7472-a451-ac8ef9f536d4")).toBe("codex-ac8ef9f536d4");
    expect(afgeleideNaam("01A17EBD-76BC-7472-A451-AC8EF9F536D4")).toBe("codex-ac8ef9f536d4");
  });
  test("de naam is een geldige busnaam", () => {
    expect(geldigeNaam(afgeleideNaam("01a17ebd-76bc-7472-a451-ac8ef9f536d4") as string)).toBe(true);
  });
  test("alles wat geen id is geeft null", () => {
    for (const v of [undefined, null, 5, {}, [], "", "kort", "zzzzzzzzzzzzzzzz", "../../etc/passwd", "01a17ebd-76bc-7472-a451-ac8ef9f536d4/../x", "a-b-c"]) expect(afgeleideNaam(v)).toBeNull();
  });
});

describe("magAfleiden", () => {
  test("zonder naam, rol en identiteitsbestand: ja", () => {
    expect(magAfleiden({}, staat, map)).toBe(true);
  });
  test("met LAB_AGENT_NAAM of LAB_AGENT_ROL: nee (een werker zonder identiteit blijft weigeren)", () => {
    expect(magAfleiden({ LAB_AGENT_NAAM: "w1" }, staat, map)).toBe(false);
    expect(magAfleiden({ LAB_AGENT_ROL: "agent" }, staat, map)).toBe(false);
  });
  test("met een identiteitsbestand voor de map of een bovenliggende map: nee, ook als het kapot of verlopen is", () => {
    mkdirSync(join(map, "sub"));
    mkdirSync(join(staat, "identiteit"), { recursive: true, mode: 0o700 });
    writeFileSync(identiteitPad(staat, map), "{kapot");
    expect(magAfleiden({}, staat, map)).toBe(false);
    expect(magAfleiden({}, staat, join(map, "sub"))).toBe(false);
    expect(magAfleiden({}, staat, dir)).toBe(true);
  });
});

describe("fail closed", () => {
  test("een cwd dat geen absoluut pad is geeft nooit een naam", () => {
    for (const c of ["", ".", "relatief/pad", "../x"]) expect(magAfleiden({}, staat, c)).toBe(false);
  });
  test("heeftIdentiteitsbestand: een andere lstat-fout dan ENOENT telt als aanwezig", () => {
    mkdirSync(join(staat, "identiteit"), { recursive: true, mode: 0o700 });
    expect(heeftIdentiteitsbestand(staat, map)).toBe(false);
    chmodSync(join(staat, "identiteit"), 0o000); // lstat op een bestand in een map zonder rechten: EACCES
    try {
      expect(heeftIdentiteitsbestand(staat, map)).toBe(true);
      expect(magAfleiden({}, staat, map)).toBe(false);
    } finally {
      chmodSync(join(staat, "identiteit"), 0o700);
    }
  });
});

describe("botstMetLevendeSessie", () => {
  const naam = "codex-ac8ef9f536d4";
  const rec = (id: string, extra = {}) => schrijfRecord(staat, { ...nieuwRecord(id, { LAB_AGENT_NAAM: naam, LAB_AGENT_ROL: "agent" }, "/w", 1), ...extra });
  test("een levende andere sessie met die naam botst; de eigen sessie, een beëindigde of een andere naam niet", () => {
    expect(botstMetLevendeSessie(staat, naam, "eigen")).toBe(false);
    rec("werker-1");
    expect(botstMetLevendeSessie(staat, naam, "eigen")).toBe(true);
    expect(botstMetLevendeSessie(staat, naam, "werker-1")).toBe(false);
    expect(botstMetLevendeSessie(staat, "codex-000000000000", "eigen")).toBe(false);
    rec("werker-1", { toestand: "weg", einde: 2 });
    expect(botstMetLevendeSessie(staat, naam, "eigen")).toBe(false);
  });
});
