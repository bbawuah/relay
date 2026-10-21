// De --dry=json-uitvoer van turbo: alleen stdout telt; waarschuwingen op stderr (remote cache niet
// beschikbaar, 403) mogen de poort niet laten crashen.
import { describe, expect, test } from "bun:test";
import { type Context, draai, geenStempel, leesDryTaken, stapE2e, type Uitkomst } from "./poort";

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
      expect(aanroepen).toEqual([["e2e", "--dry=json"], ["e2e", "--concurrency=1", "--cache=local:rw"]]);
    }
  });

  test("venster begint tijdens het wachten op een slot: FOUT, turbo draait de run niet", async () => {
    let nu = new Date("2026-10-18T02:50:00Z"); // 04:50 Amsterdam
    const { aanroepen, turbo } = nepTurbo();
    const wachtendSlot = async () => {
      nu = new Date("2026-10-18T03:01:00Z"); // 05:01
      return { vrij() {} };
    };
    const r = await stapE2e(ctx, { nu: () => nu, turbo, neemSlot: wachtendSlot });
    expect(r.status).toBe("FOUT");
    expect(r.detail).toMatch(/tijdens het wachten/);
    expect(aanroepen).toEqual([["e2e", "--dry=json"]]);
  });

  test("venster begint tijdens de run: FOUT", async () => {
    let nu = new Date("2026-10-18T02:50:00Z");
    const { turbo } = nepTurbo();
    const r = await stapE2e(ctx, {
      nu: () => nu,
      turbo: (c, t, e = []) => {
        const u = turbo(c, t, e);
        if (!e.includes("--dry=json")) nu = new Date("2026-10-18T03:01:00Z");
        return u;
      },
      neemSlot: slot,
    });
    expect(r.status).toBe("FOUT");
    expect(r.detail).toMatch(/tijdens de run/);
  });

  test("de run gaat nooit via de remote cache", async () => {
    const { aanroepen, turbo } = nepTurbo();
    await stapE2e(ctx, { nu: op("2026-10-18T02:00:00Z"), turbo, neemSlot: slot });
    expect(aanroepen[1]).toContain("--cache=local:rw");
  });
});

describe("geenStempel: alleen een volledige groene run op een vaste, schone HEAD", () => {
  const vol = { alleen: null, zonderE2e: false, ci: false };
  const a = { sha: "a".repeat(40), schoon: true };
  test("volledig, groen, schoon en dezelfde HEAD: stempel", () => {
    expect(geenStempel(0, vol, a, a)).toBeNull();
  });
  test("een commit tijdens de run: geen stempel (ook niet op de nieuwe HEAD)", () => {
    expect(geenStempel(0, vol, a, { sha: "b".repeat(40), schoon: true })).toMatch(/HEAD veranderde tijdens de run \(aaaaaaa → bbbbbbb\)/);
  });
  test("vuil bij de start of het eind: geen stempel", () => {
    expect(geenStempel(0, vol, { ...a, schoon: false }, a)).toMatch(/niet schoon/);
    expect(geenStempel(0, vol, a, { ...a, schoon: false })).toMatch(/niet schoon/);
  });
  test("--ci, --alleen, --zonder-e2e of een FOUT: geen stempel", () => {
    expect(geenStempel(0, { ...vol, ci: true }, a, a)).toMatch(/--ci/);
    expect(geenStempel(0, { ...vol, alleen: ["e2e"] }, a, a)).toMatch(/niet volledig/);
    expect(geenStempel(0, { ...vol, zonderE2e: true }, a, a)).toMatch(/niet volledig/);
    expect(geenStempel(1, vol, a, a)).toMatch(/niet groen/);
  });
});
