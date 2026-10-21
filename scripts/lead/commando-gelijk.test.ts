// packages/lab-commando importeert niets uit scripts/; deze test houdt de kopieën daar gelijk aan het origineel.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inboxRegel, inStiltevenster, MAX_REGEL_BYTES } from "@lab-bawuah/lab-commando";
import { inboxMelding, inboxPad, MAX_REGEL_BYTES as REGISTER_MAX } from "./hooks/register";
import { inStiltevenster as scriptsStilte } from "../stiltevenster";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("inbox.ts gelijk aan hooks/register.ts", () => {
  test("zelfde grens en byte voor byte dezelfde regels", () => {
    expect(MAX_REGEL_BYTES).toBe(REGISTER_MAX);
    const a = mkdtempSync(path.join(tmpdir(), "commando-gelijk-"));
    const b = mkdtempSync(path.join(tmpdir(), "commando-gelijk-"));
    dirs.push(a, b);
    const gevallen: Array<[string, string, string]> = [
      ["lead-goldcoast", "commando", "kort"],
      ["lead/met teken", "x".repeat(200), "y".repeat(3000)],
      ["lead-goldcoast", "commando", `${'"'.repeat(400)}\n\\ é`],
    ];
    const oud = process.env.LAB_LEAD_STAAT;
    process.env.LAB_LEAD_STAAT = a;
    try {
      for (const [l, v, t] of gevallen) inboxRegel(l, v, t, 42);
    } finally {
      if (oud === undefined) delete process.env.LAB_LEAD_STAAT;
      else process.env.LAB_LEAD_STAAT = oud;
    }
    for (const [l, v, t] of gevallen) inboxMelding(b, l, v, t, 42);
    for (const [l] of gevallen) expect(readFileSync(inboxPad(a, l), "utf8")).toBe(readFileSync(inboxPad(b, l), "utf8"));
  });
});

describe("inStiltevenster gelijk aan scripts/stiltevenster.ts", () => {
  test("elke 5 minuten over een jaar (zomer- en wintertijd)", () => {
    const begin = Date.UTC(2026, 0, 1);
    for (let t = begin; t < begin + 366 * 86_400_000; t += 5 * 60_000) {
      const d = new Date(t);
      if (inStiltevenster(d) !== scriptsStilte(d)) throw new Error(`verschil op ${d.toISOString()}`);
    }
  });
});
