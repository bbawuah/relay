// De --dry=json-uitvoer van turbo: alleen stdout telt; waarschuwingen op stderr (remote cache niet
// beschikbaar, 403) mogen de poort niet laten crashen.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, draai, geenStempel, gewijzigdeBestanden, geenStempelMelding, leesDryTaken, schrijfStempel, scriptsTestsOverslaan, stapE2e, stapScriptsTests, stempelOvergeslagen, type Uitkomst } from "./poort";

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
      const r = await stapE2e(ctx, { nu: op(iso), turbo, neemSlot: slot, env: {} });
      expect(r.status).toBe("FOUT");
      expect(r.detail).toMatch(/stiltevenster/);
      expect(aanroepen).toEqual([["e2e", "--dry=json"]]);
    }
  });

  test("buiten het venster draait de echte run (die dan uit de cache mag komen)", async () => {
    for (const iso of ["2026-10-18T02:59:00Z", "2026-10-18T05:15:00Z"]) {
      const { aanroepen, turbo } = nepTurbo();
      const r = await stapE2e(ctx, { nu: op(iso), turbo, neemSlot: slot, env: {} });
      expect(r.status).toBe("OK");
      expect(r.detail).toContain("1 uit cache");
      expect(aanroepen).toEqual([["e2e", "--dry=json"], ["e2e", "--concurrency=2", "--cache=local:rw"]]);
    }
  });

  test("venster begint tijdens het wachten op een slot: FOUT, turbo draait de run niet", async () => {
    let nu = new Date("2026-10-18T02:50:00Z"); // 04:50 Amsterdam
    const { aanroepen, turbo } = nepTurbo();
    const wachtendSlot = async () => {
      nu = new Date("2026-10-18T03:01:00Z"); // 05:01
      return { vrij() {} };
    };
    const r = await stapE2e(ctx, { nu: () => nu, turbo, neemSlot: wachtendSlot, env: {} });
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
      env: {},
    });
    expect(r.status).toBe("FOUT");
    expect(r.detail).toMatch(/tijdens de run/);
  });

  test("concurrency: standaard 2, POORT_E2E_CONCURRENCY 1–4 overschrijft (1 = serieel, de terugval zonder revert)", async () => {
    for (const [env, verwacht] of [[{}, "--concurrency=2"], [{ POORT_E2E_CONCURRENCY: "" }, "--concurrency=2"], [{ POORT_E2E_CONCURRENCY: "1" }, "--concurrency=1"], [{ POORT_E2E_CONCURRENCY: "4" }, "--concurrency=4"]] as const) {
      const { aanroepen, turbo } = nepTurbo();
      const r = await stapE2e(ctx, { nu: op("2026-10-18T02:00:00Z"), turbo, neemSlot: slot, env });
      expect(r.status).toBe("OK");
      expect(aanroepen[1]).toEqual(["e2e", verwacht, "--cache=local:rw"]);
    }
  });

  test("concurrency: een ongeldige POORT_E2E_CONCURRENCY faalt luid, vóór turbo en vóór het slot", async () => {
    for (const w of ["0", "5", "2.5", " 2", "-1", "twee", "1e0"]) {
      const { aanroepen, turbo } = nepTurbo();
      let slotGenomen = false;
      const r = await stapE2e(ctx, {
        nu: op("2026-10-18T02:00:00Z"),
        turbo,
        neemSlot: async () => {
          slotGenomen = true;
          return { vrij() {} };
        },
        env: { POORT_E2E_CONCURRENCY: w },
      });
      expect(r.status).toBe("FOUT");
      expect(r.detail).toContain("POORT_E2E_CONCURRENCY");
      expect(r.detail).toContain("1 tot en met 4");
      expect(aanroepen).toEqual([]);
      expect(slotGenomen).toBe(false);
    }
  });

  test("de run gaat nooit via de remote cache", async () => {
    const { aanroepen, turbo } = nepTurbo();
    await stapE2e(ctx, { nu: op("2026-10-18T02:00:00Z"), turbo, neemSlot: slot, env: {} });
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

describe("scriptsTestsOverslaan: scripts-tests alleen bij geraakte scripts e.d.", () => {
  const affected = { alles: false, ci: false };
  test("diff zonder scripts: SKIP met reden", () => {
    const reden = scriptsTestsOverslaan(affected, ["apps/goldcoast-klant/src/a.ts", "packages/ui/b.tsx"]);
    expect(reden).toContain("scripts/");
  });
  test("lege diff: SKIP", () => {
    expect(scriptsTestsOverslaan(affected, [])).not.toBeNull();
  });
  test("diff met scripts/x.ts: draait", () => {
    expect(scriptsTestsOverslaan(affected, ["apps/a.ts", "scripts/x.ts"])).toBeNull();
  });
  test.each([".githooks/pre-push", ".github/workflows/ci.yml", "package.json", "bun.lock", "turbo.json", "tsconfig.json", "tsconfig.base.json"])(
    "%s: draait",
    (f) => expect(scriptsTestsOverslaan(affected, [f])).toBeNull(),
  );
  test("een package.json, scripts-map of tsconfig in een workspace telt niet", () => {
    expect(scriptsTestsOverslaan(affected, ["apps/a/package.json", "apps/a/scripts/x.ts", "packages/b/tsconfig.json"])).not.toBeNull();
  });
  test("een verplaatsing uit scripts/ naar buiten: alleen het oude pad raakt scripts/", () => {
    expect(scriptsTestsOverslaan(affected, ["scripts/a.test.ts"])).toBeNull();
  });
  // Wegwerp-repo met een basiscommit met scripts/a.test.ts, apps/b.ts en "apps/met spatie.ts"; geen gpg-ondertekening.
  const metRepo = (f: (dir: string, g: (...a: string[]) => string, basis: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "poort-diff-"));
    try {
      const g = (...a: string[]) => {
        const r = draai(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], {}, dir);
        if (r.code !== 0) throw new Error(r.uit);
        return r.stdout;
      };
      g("init", "-q", "-b", "main");
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "apps"));
      writeFileSync(join(dir, "scripts/a.test.ts"), "import { test } from 'bun:test';\ntest('a', () => {});\n");
      writeFileSync(join(dir, "apps/b.ts"), "export const b = 1;\n");
      writeFileSync(join(dir, "apps/met spatie.ts"), "export const c = 1;\n");
      g("add", ".");
      g("commit", "-q", "-m", "basis");
      f(dir, g, g("rev-parse", "HEAD").trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test("gewijzigdeBestanden: git mv van scripts/ naar apps/ levert beide paden", () => {
    metRepo((dir, g, basis) => {
      g("mv", "scripts/a.test.ts", "apps/a.test.ts");
      g("commit", "-q", "-am", "verplaatst");
      const lijst = gewijzigdeBestanden(basis, dir);
      expect(lijst).toContain("scripts/a.test.ts");
      expect(lijst).toContain("apps/a.test.ts");
      expect(scriptsTestsOverslaan(affected, lijst)).toBeNull();
    });
  });
  test("gewijzigdeBestanden: een niet-getrackt bestand telt mee", () => {
    metRepo((dir, _g, basis) => {
      writeFileSync(join(dir, "scripts/nieuw.test.ts"), "x\n");
      expect(gewijzigdeBestanden(basis, dir)).toEqual(["scripts/nieuw.test.ts"]);
    });
  });
  test("gewijzigdeBestanden: een verwijdering (gecommit of in de werkkopie) levert het pad op", () => {
    metRepo((dir, g, basis) => {
      rmSync(join(dir, "scripts/a.test.ts"));
      expect(gewijzigdeBestanden(basis, dir)).toEqual(["scripts/a.test.ts"]);
      g("commit", "-q", "-am", "weg");
      expect(gewijzigdeBestanden(basis, dir)).toEqual(["scripts/a.test.ts"]);
    });
  });
  test("gewijzigdeBestanden: -z houdt een pad met spaties heel en geeft geen gequote pad", () => {
    metRepo((dir, _g, basis) => {
      writeFileSync(join(dir, "apps/met spatie.ts"), "export const c = 2;\n");
      writeFileSync(join(dir, "apps/é.ts"), "x\n");
      expect(gewijzigdeBestanden(basis, dir).sort()).toEqual(["apps/met spatie.ts", "apps/é.ts"]);
    });
  });
  test("gewijzigdeBestanden: een onbekende basis gooit (stapScriptsTests vangt dat op)", () => {
    metRepo((dir) => {
      expect(() => gewijzigdeBestanden("0".repeat(40), dir)).toThrow(/git diff/);
    });
  });
  test("--alles draait altijd", () => {
    expect(scriptsTestsOverslaan({ alles: true, ci: false }, ["apps/a.ts"])).toBeNull();
  });
  test("--ci draait altijd", () => {
    expect(scriptsTestsOverslaan({ alles: false, ci: true }, ["apps/a.ts"])).toBeNull();
  });
});

describe("stapScriptsTests: beslissing, lazy git en de veilige kant bij een git-fout", () => {
  const uit = (code: number, tekst: string): Uitkomst => ({ code, uit: tekst, stdout: tekst });
  const nep = (gewijzigd: (b: string) => string[], code = 0, tekst = " 12 pass\n 0 fail\n") => {
    const aanroepen = { gewijzigd: 0, draai: 0, base: 0 };
    const deps = {
      gewijzigd: (b: string) => {
        aanroepen.gewijzigd++;
        return gewijzigd(b);
      },
      draai: () => {
        aanroepen.draai++;
        return uit(code, tekst);
      },
    };
    const base = () => {
      aanroepen.base++;
      return "abc";
    };
    return { aanroepen, deps, base };
  };

  test("diff zonder scripts: SKIP met reden, bun test draait niet", () => {
    const { aanroepen, deps, base } = nep(() => ["apps/a.ts"]);
    const r = stapScriptsTests({ alles: false, ci: false }, base, deps);
    expect(r.status).toBe("SKIP");
    expect(r.detail).toContain("--alles of --ci");
    expect(aanroepen).toEqual({ gewijzigd: 1, draai: 0, base: 1 });
  });
  test("diff met scripts/x.ts: draait en meldt het aantal tests", () => {
    const { aanroepen, deps, base } = nep(() => ["scripts/x.ts"]);
    const r = stapScriptsTests({ alles: false, ci: false }, base, deps);
    expect(r).toEqual({ status: "OK", detail: "12 tests" });
    expect(aanroepen.draai).toBe(1);
  });
  test("--alles en --ci: draait, en kiest geen basis en roept geen git aan", () => {
    for (const o of [{ alles: true, ci: false }, { alles: false, ci: true }]) {
      const { aanroepen, deps, base } = nep(() => {
        throw new Error("git mag hier niet draaien");
      });
      expect(stapScriptsTests(o, base, deps).status).toBe("OK");
      expect(aanroepen).toEqual({ gewijzigd: 0, draai: 1, base: 0 });
    }
  });
  test("een falende bun test is FOUT met het aantal mislukte tests", () => {
    const { deps, base } = nep(() => ["scripts/x.ts"], 1, " 3 pass\n 1 fail\n");
    const r = stapScriptsTests({ alles: false, ci: false }, base, deps);
    expect(r.status).toBe("FOUT");
    expect(r.detail).toBe("1 mislukt");
  });
  test("git faalt (of de basis is niet te kiezen): geen exceptie, de tests draaien en de melding zegt waarom", () => {
    for (const faal of ["gewijzigd", "base"] as const) {
      const { aanroepen, deps } = nep(() => {
        throw new Error("git diff: fatal: bad revision\nmeer");
      });
      const base = () => {
        if (faal === "base") throw new Error("geen origin/main");
        return "abc";
      };
      const r = stapScriptsTests({ alles: false, ci: false }, base, deps);
      expect(r.status).toBe("OK");
      expect(r.detail).toContain("diff onleesbaar, dus gedraaid");
      expect(aanroepen.draai).toBe(1);
    }
  });
  test("git faalt en de tests falen: FOUT met dezelfde noot", () => {
    const { deps } = nep(() => {
      throw new Error("kapot");
    }, 1, " 1 fail\n");
    const r = stapScriptsTests({ alles: false, ci: false }, () => "abc", deps);
    expect(r.status).toBe("FOUT");
    expect(r.detail).toBe("1 mislukt (diff onleesbaar, dus gedraaid: kapot)");
  });
});

describe("stempelOvergeslagen: het stempel meldt wat niet draaide", () => {
  test("scripts-tests SKIP: veld overgeslagen; geen skip: geen veld", () => {
    expect(stempelOvergeslagen(["scripts-tests"])).toEqual({ overgeslagen: ["scripts-tests"] });
    expect(stempelOvergeslagen([])).toEqual({});
  });
  test("andere skips (python-tests zonder tests) horen er niet in", () => {
    expect(stempelOvergeslagen(["python-tests"])).toEqual({});
  });
  test("het veld staat in het geschreven stempel naast de vaste velden", () => {
    const tmp = mkdtempSync(join(tmpdir(), "stempel-"));
    try {
      const basis = { sha: "abc", groen: true, modus: "affected", base: "d".repeat(40), tijd: "2026-10-24T10:00:00Z" };
      schrijfStempel(tmp, { ...basis, ...stempelOvergeslagen(["scripts-tests"]) });
      const s = JSON.parse(readFileSync(join(tmp, "abc.json"), "utf8"));
      expect(s).toEqual({ ...basis, overgeslagen: ["scripts-tests"] });
      schrijfStempel(tmp, { ...basis, ...stempelOvergeslagen([]) });
      expect(JSON.parse(readFileSync(join(tmp, "abc.json"), "utf8"))).toEqual(basis);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("schrijfStempel: een niet-schrijfbare map is geen crash", () => {
  test("schrijft <sha>.json en geeft null", () => {
    const tmp = mkdtempSync(join(tmpdir(), "stempel-"));
    try {
      expect(schrijfStempel(join(tmp, "a/b"), { sha: "abc", groen: true })).toBeNull();
      expect(JSON.parse(readFileSync(join(tmp, "a/b/abc.json"), "utf8"))).toEqual({ sha: "abc", groen: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  test("de map is niet te maken (een bestand staat in de weg): de fout komt terug, er wordt niet gegooid", () => {
    const tmp = mkdtempSync(join(tmpdir(), "stempel-"));
    try {
      writeFileSync(join(tmp, "bezet"), "");
      const fout = schrijfStempel(join(tmp, "bezet/poort"), { sha: "abc" });
      expect(fout).toBeTruthy();
      expect(geenStempelMelding(fout ?? "")).toMatch(/^LET OP poort: groen, maar GEEN stempel geschreven \(.+\)\. merge\.sh weigert/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
