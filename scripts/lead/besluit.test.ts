import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { leesBesluit } from "../../apps/tmux/server/besluiten";
import { leesArgs, leesEen, lijstRegels, maakBesluit, schrijfNieuw } from "./besluit";

const dir = mkdtempSync(path.join(tmpdir(), "besluit-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SCRIPT = path.join(import.meta.dir, "besluit.ts");

const args = ["--id", "hook-plek", "--titel", "Compactie-hook op één plek", "--vraag", "Hook naar settings?", "--optie", "ja=Akkoord", "--optie", "nee=Niet doen", "--passkey"];

describe("besluit.ts", () => {
  test("args: values, the flag and repeated options", () => {
    expect(leesArgs(["nieuw", ...args])).toEqual({
      pos: ["nieuw"],
      o: { id: "hook-plek", titel: "Compactie-hook op één plek", vraag: "Hook naar settings?", optie: ["ja=Akkoord", "nee=Niet doen"], passkey: true },
    });
    expect(() => leesArgs(["--id"])).toThrow("mist een waarde");
  });

  test("a new decision passes the server's schema; the proposal defaults to the first option", () => {
    const b = maakBesluit(leesArgs(args).o, new Date("2026-10-06T10:38:00Z"));
    expect(b).toMatchObject({ id: "hook-plek", voorstel: "ja", passkey: true, tijd: "2026-10-06T10:38:00.000Z" });
    expect(leesBesluit(b)).toEqual(b);
  });

  test("invalid input is refused with the rules", () => {
    expect(() => maakBesluit(leesArgs([...args, "--id", "../weg"]).o)).toThrow("Ongeldig besluit");
    expect(() => maakBesluit(leesArgs(["--id", "x-1", "--titel", "t", "--vraag", "v", "--optie", "ja=A"]).o)).toThrow("Ongeldig besluit");
    expect(() => maakBesluit(leesArgs([...args, "--voorstel", "misschien"]).o)).toThrow("Ongeldig besluit");
    expect(() => maakBesluit(leesArgs(["--optie", "geenis"]).o)).toThrow("id=label");
  });

  test("written 600 in a 700 folder; never overwritten; read and listed back", () => {
    const map = path.join(dir, "besluiten");
    const b = maakBesluit(leesArgs(args).o);
    const pad = schrijfNieuw(map, b);
    expect(statSync(pad).mode & 0o777).toBe(0o600);
    expect(statSync(map).mode & 0o777).toBe(0o700);
    expect(() => schrijfNieuw(map, b)).toThrow();
    expect(leesEen(map, "hook-plek")).toEqual(b);
    expect(leesEen(map, "../hook-plek")).toBeNull();
    writeFileSync(path.join(map, "kapot.json"), "{");
    const keuze = { ...b, id: "al-klaar", keuze: { optie: "nee", toelichting: "later", door: "iphone", tijd: "2026-10-06T11:00:00Z" } };
    writeFileSync(path.join(map, "al-klaar.json"), JSON.stringify(keuze));
    expect(lijstRegels(map)).toEqual([
      "beslist   al-klaar  → nee (met toelichting)  Compactie-hook op één plek",
      "open      hook-plek  Compactie-hook op één plek  [passkey]",
      "ongeldig  kapot.json",
    ]);
  });

  test("the command line: nieuw, lijst, lees, and usage", () => {
    const map = path.join(dir, "cli");
    const draai = (...a: string[]) => {
      const p = Bun.spawnSync(["bun", SCRIPT, ...a, "--map", map], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LAB_LEAD_NAAM: "labbawuah-1c" } });
      return { code: p.exitCode, uit: p.stdout.toString(), fout: p.stderr.toString() };
    };
    expect(draai("nieuw", ...args).code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(map, "hook-plek.json"), "utf8")).door).toBe("labbawuah-1c");
    expect(draai("lijst").uit).toContain("open      hook-plek");
    expect(JSON.parse(draai("lees", "hook-plek").uit).id).toBe("hook-plek");
    expect(draai("lees", "bestaat-niet").code).toBe(1);
    expect(draai("nieuw", ...args).code).toBe(1);
    expect(draai("onzin").code).toBe(2);
  });
});
