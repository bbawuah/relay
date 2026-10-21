import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inboxPad } from "../hooks/register";
import { inboxRegel } from "./inbox";

const staat = mkdtempSync(path.join(tmpdir(), "commando-inbox-"));
afterAll(() => rmSync(staat, { recursive: true, force: true }));

describe("inboxRegel", () => {
  test("schrijft {t,van,tekst} in de inbox van de lead (LAB_LEAD_STAAT)", () => {
    const oud = process.env.LAB_LEAD_STAAT;
    process.env.LAB_LEAD_STAAT = staat;
    try {
      inboxRegel("lead-goldcoast", "commando", "tak-weg-abc: klaar (exit 0)", 1_700_000_000_000);
      inboxRegel("lead-goldcoast", "commando", "x".repeat(2000), 1_700_000_000_001);
    } finally {
      if (oud === undefined) delete process.env.LAB_LEAD_STAAT;
      else process.env.LAB_LEAD_STAAT = oud;
    }
    const regels = readFileSync(inboxPad(staat, "lead-goldcoast"), "utf8").trim().split("\n");
    expect(JSON.parse(regels[0]!)).toEqual({ t: 1_700_000_000_000, van: "commando", tekst: "tak-weg-abc: klaar (exit 0)" });
    expect(Buffer.byteLength(regels[1]!)).toBeLessThan(512);
    expect(JSON.parse(regels[1]!).t).toBe(1_700_000_000_001);
  });
});
