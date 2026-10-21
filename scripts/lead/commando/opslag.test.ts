import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandoMap, kloonPad, leesGewoonBestand, MAPPEN, schrijfAtomair, zorgVoorMappen } from "./opslag";

const dir = mkdtempSync(path.join(tmpdir(), "commando-opslag-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("opslag", () => {
  test("LAB_COMMANDO en LAB_COMMANDO_KLOON overschrijven de standaardmappen", () => {
    const oud = { c: process.env.LAB_COMMANDO, k: process.env.LAB_COMMANDO_KLOON };
    process.env.LAB_COMMANDO = "/x/commando";
    process.env.LAB_COMMANDO_KLOON = "/x/kloon";
    expect(commandoMap()).toBe("/x/commando");
    expect(kloonPad()).toBe("/x/kloon");
    delete process.env.LAB_COMMANDO;
    delete process.env.LAB_COMMANDO_KLOON;
    expect(commandoMap()).toMatch(/\.local\/state\/lab-commando$/);
    expect(kloonPad()).toMatch(/Library\/Application Support\/lab-b\/commando\/bron$/);
    if (oud.c !== undefined) process.env.LAB_COMMANDO = oud.c;
    if (oud.k !== undefined) process.env.LAB_COMMANDO_KLOON = oud.k;
  });

  test("mappen zijn 700 en bestanden 600", () => {
    const basis = path.join(dir, "a");
    zorgVoorMappen(basis);
    expect(statSync(basis).mode & 0o777).toBe(0o700);
    for (const m of Object.values(MAPPEN)) expect(statSync(path.join(basis, m)).mode & 0o777).toBe(0o700);
    const p = path.join(basis, MAPPEN.verzoeken, "x.json");
    schrijfAtomair(p, "{}");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(leesGewoonBestand(p)).toBe("{}");
  });

  test("schrijfAtomair laat geen tmp-bestand achter en overschrijft", () => {
    const basis = path.join(dir, "b");
    zorgVoorMappen(basis);
    const p = path.join(basis, MAPPEN.uitslag, "y.json");
    schrijfAtomair(p, "een");
    schrijfAtomair(p, "twee");
    expect(leesGewoonBestand(p)).toBe("twee");
    expect(Bun.spawnSync(["ls", path.join(basis, MAPPEN.uitslag)]).stdout.toString().trim()).toBe("y.json");
  });

  test("een symlink als bestand wordt geweigerd", () => {
    const echt = path.join(dir, "echt.txt");
    writeFileSync(echt, "geheim");
    const link = path.join(dir, "link.txt");
    symlinkSync(echt, link);
    expect(() => leesGewoonBestand(link)).toThrow("symlink");
  });

  test("een symlink als map wordt geweigerd", () => {
    const echteMap = path.join(dir, "echte-map");
    mkdirSync(echteMap);
    writeFileSync(path.join(echteMap, "f.json"), "{}");
    const linkMap = path.join(dir, "link-map");
    symlinkSync(echteMap, linkMap);
    expect(() => leesGewoonBestand(path.join(linkMap, "f.json"))).toThrow("symlink");
  });

  test("een map en een te groot bestand worden geweigerd; max is instelbaar", () => {
    expect(() => leesGewoonBestand(dir)).toThrow("geen gewoon bestand");
    const groot = path.join(dir, "groot.txt");
    writeFileSync(groot, "x".repeat(100));
    expect(() => leesGewoonBestand(groot, 50)).toThrow("te groot");
    expect(leesGewoonBestand(groot, 100)).toHaveLength(100);
    writeFileSync(path.join(dir, "standaard.txt"), "x".repeat(64 * 1024 + 1));
    expect(() => leesGewoonBestand(path.join(dir, "standaard.txt"))).toThrow("te groot");
  });

  test("een ontbrekend bestand gooit", () => {
    expect(() => leesGewoonBestand(path.join(dir, "bestaat-niet"))).toThrow();
  });
});
