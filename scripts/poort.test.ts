// De --dry=json-uitvoer van turbo: alleen stdout telt; waarschuwingen op stderr (remote cache niet
// beschikbaar, 403) mogen de poort niet laten crashen.
import { describe, expect, test } from "bun:test";
import { draai, leesDryTaken } from "./poort";

const PLAN = JSON.stringify({ tasks: [{ task: "e2e", package: "@lab-bawuah/tmux", command: "bun run test:tmux" }] }, null, 2);

describe("leesDryTaken", () => {
  test("geldige JSON geeft de taken", () => {
    expect(leesDryTaken(PLAN)?.map((t) => t.package)).toEqual(["@lab-bawuah/tmux"]);
  });
  test("tekst vóór de JSON (op stdout) wordt overgeslagen", () => {
    expect(leesDryTaken(`turbo 2.x\n${PLAN}`)).toHaveLength(1);
  });
  test("geen JSON of geen tasks = null, geen crash", () => {
    expect(leesDryTaken("")).toBeNull();
    expect(leesDryTaken("WARNING Remote caching unavailable")).toBeNull();
    expect(leesDryTaken('{"iets": 1}')).toBeNull();
  });
});

describe("draai scheidt stdout en stderr", () => {
  // Een proces dat een WARNING-regel op stderr zet midden in de JSON op stdout.
  const helft = Math.floor(PLAN.length / 2);
  const script = `process.stdout.write(${JSON.stringify(PLAN.slice(0, helft))}); process.stderr.write("WARNING Remote caching unavailable: returned 403\\n"); process.stdout.write(${JSON.stringify(PLAN.slice(helft))});`;
  const r = draai([process.execPath, "-e", script]);

  test("uit (samengevoegd) bevat de waarschuwing midden in de JSON, en is dus geen JSON meer", () => {
    expect(r.uit).toContain("WARNING Remote caching unavailable");
    expect(() => JSON.parse(r.uit.slice(r.uit.indexOf("{")))).toThrow();
  });
  test("stdout alleen is de ongestoorde JSON en leesDryTaken leest hem", () => {
    expect(r.stdout).not.toContain("WARNING");
    expect(leesDryTaken(r.stdout)).toHaveLength(1);
  });
});
