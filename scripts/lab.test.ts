// `bun lab`: elk script staat in de tabel of in NIET_IN_LAB met een reden, elk pad bestaat,
// en argumenten, werkmap en exitcode gaan ongewijzigd door (met nep-scripts in een tijdelijke map).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bestand, type Commando, help, LAB, ROOT, voerUit, zoek } from "./lab";

/** Scripts in scripts/ en scripts/lead/ die bewust geen lab-commando zijn. */
const NIET_IN_LAB: Record<string, string> = {
  "scripts/bewijs-pr.ts": "CI-check in GitHub Actions (bewijs-pr), niet voor de hand",
  "scripts/db-verplicht.ts": "poorthulp, gebruikt door poort.ts",
  "scripts/ds-regels.ts": "poortstap, draait via `bun lab poort`",
  "scripts/e2e-slot.ts": "poorthulp, gebruikt door poort.ts",
  "scripts/echte-klok.ts": "poortstap, draait via `bun lab poort`",
  "scripts/gc-data-laag.ts": "poortstap, draait via `bun lab poort`",
  "scripts/git-scrub.ts": "poortstap, draait via `bun lab poort`",
  "scripts/mollie-sleutels.ts": "poortstap, draait via `bun lab poort`",
  "scripts/poort-log.ts": "poorthulp (logbestand van de run), gebruikt door poort.ts",
  "scripts/rood-op-basis.ts": "poortstap, draait via `bun lab poort`",
  "scripts/test-integriteit.ts": "poortstap, draait via `bun lab poort`",
  "scripts/test-tenant.ts": "poortstap, draait via `bun lab poort`",
  "scripts/werk-commentaar.ts": "poortstap, draait via `bun lab poort`",
  "scripts/typen-modules.d.ts": "typedeclaratie (pngjs) voor scripts/tsconfig.json, geen script",
  "scripts/scripts-tests-veilig.ts": "poorthulp (allowlist van de stap scripts-tests), gebruikt door poort.ts",
  "scripts/stiltevenster.ts": "hulpmodule en check voor hooks en poort, geen commando voor de hand",
  "scripts/prive-server.ts": "de dienst zelf; draait als LaunchAgent via `bun lab installeer prive-server` (twijfelgeval, Brian beslist)",
  "scripts/site-shots.ts": "shots van lab-b.dev bij een packages-merge (twijfelgeval, Brian beslist)",
  "scripts/lab.ts": "de ingang zelf",
  "scripts/lead/git-hard.ts": "geharde git-helper voor de lead-tooling, geen commando",
  "scripts/lead/git-hard.testhulp.ts": "hulp voor git-hard.test.ts (mutatietests), geen commando",
  "scripts/lead/leadnaam.ts": "hulp voor spawn.sh",
  "scripts/lead/spawn-crash.ts": "hulp voor tests",
  "scripts/lead/push-werker.sh": "alleen voor de lead, met rol en argumenten (<worktree> <sha> <tak>); bewust geen algemeen commando (besluit Brian 27 okt, #683)",
};

const tijdelijk = mkdtempSync(path.join(tmpdir(), "lab-test-"));
afterAll(() => rmSync(tijdelijk, { recursive: true, force: true }));

describe("tabel", () => {
  test("elk script in scripts/ en scripts/lead/ staat in de tabel of in NIET_IN_LAB met reden", () => {
    const scripts = ["scripts/*.{ts,sh}", "scripts/lead/*.{ts,sh}"]
      .flatMap((p) => [...new Bun.Glob(p).scanSync({ cwd: ROOT })])
      .filter((f) => !/\.test\.ts$/.test(f))
      .sort();
    expect(scripts).toContain("scripts/poort.ts");
    const inTabel = new Set(Object.values(LAB).map((c) => c.pad));
    const zonder = scripts.filter((f) => !inTabel.has(f) && !NIET_IN_LAB[f]);
    expect(zonder, `niet in de lab-tabel en niet in NIET_IN_LAB (met reden): ${zonder.join(", ")}`).toEqual([]);
    const dubbel = Object.keys(NIET_IN_LAB).filter((f) => inTabel.has(f));
    expect(dubbel, "staat in de tabel én in NIET_IN_LAB").toEqual([]);
    const weg = Object.keys(NIET_IN_LAB).filter((f) => !scripts.includes(f));
    expect(weg, "NIET_IN_LAB noemt een script dat niet (meer) bestaat").toEqual([]);
    for (const [f, reden] of Object.entries(NIET_IN_LAB)) expect(reden.trim().length, f).toBeGreaterThan(0);
  });

  test("elk pad in de tabel bestaat, met een uitleg van één regel", () => {
    for (const [naam, c] of Object.entries(LAB)) {
      expect(existsSync(path.join(ROOT, c.pad)), `${naam}: ${c.pad}`).toBe(true);
      expect(c.uitleg.length > 0 && !c.uitleg.includes("\n"), naam).toBe(true);
    }
  });

  test("de minimale commando's uit de opdracht", () => {
    const moet = ["status", "spawn", "merge", "push", "wachtrij", "besluit", "vraag-brian", "hernoem", "lees", "poort", "check", "bekijk", "meting", "nieuw", "installeer hooks", "installeer grens", "installeer prive-server", "publiceer", "uitrol tmux", "uitrol vault-b", "uitrol watchparty"];
    expect(Object.keys(LAB).sort()).toEqual([...moet].sort());
  });

  test("zoek: twee woorden gaan voor één, de rest blijft argument", () => {
    expect(zoek(["installeer", "hooks", "--droog"])).toEqual({ naam: "installeer hooks", rest: ["--droog"] });
    expect(zoek(["merge", "12", "--droog"])).toEqual({ naam: "merge", rest: ["12", "--droog"] });
    expect(zoek(["uitrol", "elders"])).toBeNull();
    expect(zoek([])).toBeNull();
  });

  test("help: elke groep en elk commando", () => {
    const h = help();
    for (const g of ["lead:", "poort:", "installeren:", "publiceren:", "uitrol:"]) expect(h).toContain(g);
    for (const naam of Object.keys(LAB)) expect(h).toContain(`  ${naam} `);
  });
});

describe("doorgeven (nep-scripts)", () => {
  const root = path.join(tijdelijk, "repo");
  const werkmap = path.join(tijdelijk, "elders");
  mkdirSync(path.join(root, "s"), { recursive: true });
  mkdirSync(werkmap, { recursive: true });
  const uit = path.join(tijdelijk, "uit.json");
  writeFileSync(path.join(root, "s/nep.sh"), `printf '%s\\n' "$(pwd -P)" "$@" > "${uit}"\nexit 7\n`);
  writeFileSync(path.join(root, "s/nep.ts"), `await Bun.write(${JSON.stringify(uit)}, [process.cwd(), ...process.argv.slice(2)].join("\\n") + "\\n");\nprocess.exit(5);\n`);
  const lees = () => readFileSync(uit, "utf8").replace(/\n$/, "").split("\n");

  test("bash: argumenten (met spatie), werkmap en exitcode", async () => {
    const c: Commando = { pad: "s/nep.sh", runner: "bash", groep: "lead", uitleg: "nep" };
    expect(await voerUit(c, ["a b", "--droog", ""], { root, werkmap })).toBe(7);
    expect(lees()).toEqual([realpathSync(werkmap), "a b", "--droog", ""]);
  });

  test("bun: vaste argumenten eerst, dan die van de aanroeper", async () => {
    const c: Commando = { pad: "s/nep.ts", runner: "bun", groep: "poort", uitleg: "nep", vooraf: ["--zonder-e2e"] };
    expect(await voerUit(c, ["x"], { root, werkmap })).toBe(5);
    const [cwd, ...args] = lees();
    expect(realpathSync(cwd)).toBe(realpathSync(werkmap));
    expect(args).toEqual(["--zonder-e2e", "x"]);
  });

  test("merge: de vaste kopie als die bestaat, anders de repo-versie met een melding", () => {
    const vast = path.join(tijdelijk, "vast-merge.sh");
    const c: Commando = { pad: "s/nep.sh", vast, runner: "bash", groep: "lead", uitleg: "nep" };
    const zonder = bestand(c, root);
    expect(zonder.pad).toBe(path.join(root, "s/nep.sh"));
    expect(zonder.melding).toContain("vaste kopie ontbreekt");
    writeFileSync(vast, "exit 0\n");
    expect(bestand(c, root)).toEqual({ pad: vast });
    expect(LAB.merge.vast).toBe("/usr/local/lib/lab-lead/merge.sh");
    expect(LAB.merge.pad).toBe("scripts/lead/merge.sh");
  });
});

describe("cli", () => {
  const lab = (...args: string[]) => Bun.spawnSync([process.execPath, path.join(ROOT, "scripts/lab.ts"), ...args], { cwd: tijdelijk, stdout: "pipe", stderr: "pipe" });

  test("een onbekend commando: exit 2 en de lijst", () => {
    const r = lab("bestaat-niet", "x");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('onbekend commando "bestaat-niet x"');
    expect(r.stderr.toString()).toContain("installeer hooks");
  });

  test("zonder argument en met help: het overzicht, exit 0", () => {
    for (const a of [[], ["help"]]) {
      const r = lab(...a);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("uitrol tmux");
    }
    expect(lab("help", "bestaat-niet").exitCode).toBe(2);
  });
});
