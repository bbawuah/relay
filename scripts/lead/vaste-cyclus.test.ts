import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// De Workflow-tool draait het script als body van een async functie (top-level return en await).
// Alleen parsen, niet uitvoeren: de globals (agent, pipeline, args) bestaan hier niet.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

test("vaste-cyclus.js parst als workflow-script", () => {
  const bron = readFileSync(join(import.meta.dir, "vaste-cyclus.js"), "utf8").replace(/^export const meta/m, "const meta");
  expect(() => new AsyncFunction(bron)).not.toThrow();
});
