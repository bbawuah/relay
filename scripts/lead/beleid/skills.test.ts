import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installeer } from "./installeer-skills";

let dir: string;
let repo: string;
let lokaal: string;
let claude: string;
let codex: string;
const marker = ".lab-beleid-skill.json";

const schrijf = (root: string, naam: string, tekst = "---\nname: x\n---\n# x\n") => {
  const d = join(root, naam);
  mkdirSync(join(d, "references"), { recursive: true });
  writeFileSync(join(d, "SKILL.md"), tekst);
  writeFileSync(join(d, "references", "hulp.md"), "hulp\n");
};
const opties = (doel: string, extra: Record<string, unknown> = {}) => ({ doel, repo, lokaal, droog: false, controle: false, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beleid-skills-"));
  repo = join(dir, "repo"); lokaal = join(dir, "vault"); claude = join(dir, "claude", "skills"); codex = join(dir, "codex", "skills");
  mkdirSync(repo); mkdirSync(lokaal); mkdirSync(claude, { recursive: true }); mkdirSync(codex, { recursive: true });
  schrijf(repo, "lead"); schrijf(repo, "retro"); schrijf(repo, "grill-me"); schrijf(lokaal, "naar-mod");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("installeer-skills", () => {
  test("weigert een symlink in de bron (marker of genest) en schrijft nooit buiten het doel", () => {
    const buiten = join(dir, "buiten.txt");
    for (const link of [join(repo, "lead", marker), join(repo, "retro", "references", "link.md")]) {
      writeFileSync(buiten, "ORIGINEEL\n");
      symlinkSync(buiten, link);
      expect(() => installeer(opties(claude))).toThrow(/symlink/i);
      expect(readFileSync(buiten, "utf8")).toBe("ORIGINEEL\n");
      rmSync(link);
    }
  });
  test("droog toont wijzigingen maar schrijft niets", () => {
    const r = installeer(opties(claude, { droog: true }));
    expect(r.join("\n")).toContain("lead");
    expect(existsSync(join(claude, "lead"))).toBe(false);
    expect(existsSync(join(codex, "lead"))).toBe(false);
  });
  test("droog toont een diff van gewijzigde SKILL.md zonder het doel te wijzigen", () => {
    installeer(opties(claude));
    writeFileSync(join(claude, "lead", "SKILL.md"), "oud\n");
    const voor = readFileSync(join(claude, "lead", "SKILL.md"), "utf8");
    const r = installeer(opties(claude, { droog: true }));
    expect(r.join("\n")).toContain("---");
    expect(r.join("\n")).toContain("+ ");
    expect(readFileSync(join(claude, "lead", "SKILL.md"), "utf8")).toBe(voor);
  });
  test("installeert repo- en lokale allowlist naar beide hosts, gemarkeerd", () => {
    for (const doel of [claude, codex]) installeer(opties(doel));
    for (const doel of [claude, codex]) {
      for (const naam of ["lead", "retro", "grill-me", "naar-mod"]) {
        expect(readFileSync(join(doel, naam, "SKILL.md"), "utf8")).toContain("#");
        expect(existsSync(join(doel, naam, marker))).toBe(true);
      }
    }
  });
  test("weigert een bestaande ongemarkeerde map en raakt .system en synced nooit", () => {
    mkdirSync(join(claude, "lead")); writeFileSync(join(claude, "lead", "SKILL.md"), "eigen\n");
    mkdirSync(join(claude, ".system")); mkdirSync(join(claude, "synced"));
    expect(() => installeer(opties(claude))).toThrow();
    expect(readFileSync(join(claude, "lead", "SKILL.md"), "utf8")).toBe("eigen\n");
    expect(existsSync(join(claude, ".system"))).toBe(true);
    expect(existsSync(join(claude, "synced"))).toBe(true);
  });
  test("vervangt alleen een eigen gemarkeerde map met backup .voor-beleid en laat bronnen ongemoeid", () => {
    installeer(opties(claude));
    writeFileSync(join(claude, "lead", "SKILL.md"), "oud\n");
    const bron = readFileSync(join(repo, "lead", "SKILL.md"), "utf8");
    installeer(opties(claude));
    expect(existsSync(join(claude, "lead.voor-beleid", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(claude, "lead", "SKILL.md"), "utf8")).toBe(bron);
    expect(readFileSync(join(repo, "lead", "SKILL.md"), "utf8")).toBe(bron);
  });
});
