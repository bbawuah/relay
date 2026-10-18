// De --dry=json-uitvoer van turbo: alleen stdout telt; waarschuwingen op stderr (remote cache niet
// beschikbaar, 403) mogen de poort niet laten crashen.
import { describe, expect, test } from "bun:test";
import { type Context, draai, leesDryTaken, stapE2e, type Uitkomst } from "./poort";

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

describe("stapE2e: stiltevenster vóór turbo (geen groene cachehit in het venster)", () => {
  const ctx: Context = { affected: false, base: null, env: {} };
  const uitkomst = (stdout: string, code = 0): Uitkomst => ({ code, uit: stdout, stdout });
  const nepTurbo = () => {
    const aanroepen: string[][] = [];
    const turbo = (_c: Context, taken: string[], extra: string[] = []) => {
      aanroepen.push([...taken, ...extra]);
      return extra.includes("--dry=json") ? uitkomst(PLAN) : uitkomst("Tasks:    1 successful, 1 total\nCached:    1 cached, 1 total\n");
    };
    return { aanroepen, turbo };
  };
  const slot = async () => ({ vrij() {} });
  const op = (iso: string) => () => new Date(iso);

  test("in het venster (05:00–07:14 Amsterdam) is de stap FOUT en draait turbo alleen de --dry", async () => {
    for (const iso of ["2026-10-18T03:00:00Z", "2026-10-18T05:14:00Z", "2026-07-01T03:00:00Z"]) {
      const { aanroepen, turbo } = nepTurbo();
      const r = await stapE2e(ctx, { nu: op(iso), turbo, neemSlot: slot });
      expect(r.status).toBe("FOUT");
      expect(r.detail).toMatch(/stiltevenster/);
      expect(aanroepen).toEqual([["e2e", "--dry=json"]]);
    }
  });

  test("buiten het venster draait de echte run (die dan uit de cache mag komen)", async () => {
    for (const iso of ["2026-10-18T02:59:00Z", "2026-10-18T05:15:00Z"]) {
      const { aanroepen, turbo } = nepTurbo();
      const r = await stapE2e(ctx, { nu: op(iso), turbo, neemSlot: slot });
      expect(r.status).toBe("OK");
      expect(r.detail).toContain("1 uit cache");
      expect(aanroepen).toEqual([["e2e", "--dry=json"], ["e2e", "--concurrency=1"]]);
    }
  });
});
