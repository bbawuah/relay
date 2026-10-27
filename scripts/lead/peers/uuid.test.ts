import { describe, expect, test } from "bun:test";
import { uuidv7 } from "./uuid";

const T0 = 1_700_000_000_000;

describe("uuidv7", () => {
  test("heeft de vorm van RFC 9562: versie 7, variant 10", () => {
    const u = uuidv7(T0);
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("de eerste 48 bit zijn de tijd in ms", () => {
    const u = uuidv7(T0 + 5_000_000);
    const hex = u.replace(/-/g, "").slice(0, 12);
    expect(parseInt(hex, 16)).toBeGreaterThanOrEqual(T0 + 5_000_000);
  });

  test("strikt stijgend, ook in dezelfde milliseconde en bij een klok die terugloopt", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5000; i++) ids.push(uuidv7(T0 + 10_000_000));
    ids.push(uuidv7(T0)); // klok terug
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("sorteert op tijd", () => {
    const a = uuidv7(T0 + 20_000_000);
    const b = uuidv7(T0 + 30_000_000);
    expect(a < b).toBe(true);
  });
});
