import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identiteitPad } from "../hooks/register";
import { afgeleideNaam, magAfleiden } from "./afgeleide-naam";
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
