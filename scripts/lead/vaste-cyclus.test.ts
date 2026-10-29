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

test("de optionele workflow gebruikt host- of taakmodellen en roept alleen de geïnjecteerde nepagents aan", async () => {
  const bron = readFileSync(join(import.meta.dir, "vaste-cyclus.js"), "utf8").replace(/^export const meta/m, "const meta");
  const calls: { prompt: string; model: unknown }[] = [];
  const agent = async (prompt: string, opties: { phase: string; model?: unknown }) => {
    calls.push({ prompt, model: opties.model });
    return opties.phase === "Review" ? { oordeel: "akkoord", blokkerend: [], nietBlokkerend: [] } : { pr: 1, tak: "fixture", sha: "fixture-sha", tests: "fixture" };
  };
  const pipeline = async (taken: unknown[], ...stappen: ((x: any, taak: unknown) => Promise<any>)[]) => Promise.all(taken.map(async (taak) => {
    let x: unknown = taak;
    for (const stap of stappen) x = await stap(x, taak);
    return x;
  }));
  const workflow = new AsyncFunction("agent", "pipeline", "args", "log", bron);
  await workflow(agent, pipeline, { taken: [{ id: "1", tak: "fixture", opdracht: "fixture task" }] }, () => {});
  expect(calls.map((c) => c.model)).toEqual([undefined, undefined]);
  expect(calls.every((c) => !c.prompt.includes("Vaste grenzen:") && !c.prompt.includes("lab-bawuah"))).toBe(true);
  calls.length = 0;
  await workflow(agent, pipeline, { model: "caller-model", taken: [{ id: "1", tak: "fixture", opdracht: "fixture task", reviewModel: "caller-review" }] }, () => {});
  expect(calls.map((c) => c.model)).toEqual(["caller-model", "caller-review"]);
});
