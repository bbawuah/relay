import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const cliControle = (doel: string) => Bun.spawnSync([process.execPath, join(import.meta.dir, "installeer-skills.ts"), "--doel", doel, "--controle"], { env: { ...process.env, HOME: dir } });

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
  test("valideert alle bronnen vóór ook maar één staging-kopie", () => {
    const link = join(repo, "retro", "references", "link.md");
    symlinkSync(join(repo, "lead", "SKILL.md"), link);
    let staged = 0;
    expect(() => installeer(opties(claude), { voorStageer: () => staged++ })).toThrow(/symlink/i);
    expect(staged).toBe(0);
    expect(existsSync(join(claude, "lead"))).toBe(false);
  });
  test("kopieerfout in de laatste skill laat bestaande doelen ongemoeid en ruimt staging op", () => {
    installeer(opties(claude));
    const voorLead = readFileSync(join(claude, "lead", "SKILL.md"));
    const voorRetro = readFileSync(join(claude, "retro", "SKILL.md"));
    rmSync(join(claude, "grill-me"), { recursive: true, force: true });
    const onleesbaar = join(repo, "grill-me", "references", "hulp.md");
    chmodSync(onleesbaar, 0);
    try { expect(() => installeer(opties(claude))).toThrow(); }
    finally { chmodSync(onleesbaar, 0o644); }
    expect(readFileSync(join(claude, "lead", "SKILL.md")).equals(voorLead)).toBe(true);
    expect(readFileSync(join(claude, "retro", "SKILL.md")).equals(voorRetro)).toBe(true);
    expect(existsSync(join(claude, "grill-me"))).toBe(false);
    expect(readdirSync(join(dir, "claude")).some((n) => n.includes("beleid-staging"))).toBe(false);
    expect(() => installeer(opties(claude))).not.toThrow();
    expect(existsSync(join(claude, "grill-me", marker))).toBe(true);
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
  test("droog toont ook een bestandsdiff in references zonder het doel te wijzigen", () => {
    installeer(opties(claude));
    writeFileSync(join(claude, "lead", "references", "hulp.md"), "oud hulpmiddel\n");
    const voor = readFileSync(join(claude, "lead", "references", "hulp.md"), "utf8");
    const r = installeer(opties(claude, { droog: true })).join("\n");
    expect(r).toContain("references/hulp.md");
    expect(r).toContain("- oud hulpmiddel");
    expect(r).toContain("+ hulp");
    expect(readFileSync(join(claude, "lead", "references", "hulp.md"), "utf8")).toBe(voor);
  });
  test("controle meldt drift zonder te installeren", () => {
    installeer(opties(claude));
    writeFileSync(join(claude, "lead", "SKILL.md"), "afwijkend\n");
    const voor = readFileSync(join(claude, "lead", "SKILL.md"), "utf8");
    const r = installeer(opties(claude, { controle: true }));
    expect(r.join("\n")).toContain("drift");
    expect(r.join("\n")).toContain("lead");
    expect(readFileSync(join(claude, "lead", "SKILL.md"), "utf8")).toBe(voor);
  });
  test("controle meldt een onbeheerde skillmap zonder te schrijven", () => {
    installeer(opties(claude));
    mkdirSync(join(claude, "oude-skill")); writeFileSync(join(claude, "oude-skill", "SKILL.md"), "eigen\n");
    const voor = readFileSync(join(claude, "oude-skill", "SKILL.md"), "utf8");
    const r = installeer(opties(claude, { controle: true })).join("\n");
    expect(r).toContain("oude-skill");
    expect(r).toContain("onbeheerde skillmap");
    expect(readFileSync(join(claude, "oude-skill", "SKILL.md"), "utf8")).toBe(voor);
  });
  test("controle-CLI is nul bij gelijkheid en niet-nul met skillnaam bij drift, zonder schrijven", () => {
    const doel = join(dir, "cli", "skills");
    installeer({ doel, repo: join(import.meta.dir, "../../..", "agents/skills"), lokaal: join(dir, "lege-vault") });
    expect(cliControle(doel).exitCode).toBe(0);
    writeFileSync(join(doel, "lead", "SKILL.md"), "drift\n");
    const voor = readFileSync(join(doel, "lead", "SKILL.md"), "utf8");
    const drift = cliControle(doel);
    expect(drift.exitCode).not.toBe(0);
    expect(drift.stdout.toString()).toContain("lead");
    expect(readFileSync(join(doel, "lead", "SKILL.md"), "utf8")).toBe(voor);
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
  test("bewaart elke backup buiten skills en laat eerdere backups ongemoeid", () => {
    installeer(opties(claude));
    writeFileSync(join(claude, "lead", "SKILL.md"), "oud\n");
    const bron = readFileSync(join(repo, "lead", "SKILL.md"), "utf8");
    installeer(opties(claude));
    expect(existsSync(join(claude, "lead.voor-beleid"))).toBe(false);
    const backups = readdirSync(join(dir, "claude", ".lab-beleid-backups")).filter((naam) => naam.startsWith("lead.voor-beleid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, "claude", ".lab-beleid-backups", backups[0]!, "SKILL.md"), "utf8")).toBe("oud\n");
    writeFileSync(join(claude, "lead", "SKILL.md"), "nieuwer oud\n");
    installeer(opties(claude));
    const tweede = readdirSync(join(dir, "claude", ".lab-beleid-backups")).filter((naam) => naam.startsWith("lead.voor-beleid-"));
    expect(tweede).toHaveLength(2);
    expect(tweede.some((naam) => readFileSync(join(dir, "claude", ".lab-beleid-backups", naam, "SKILL.md"), "utf8") === "oud\n")).toBe(true);
    expect(readFileSync(join(claude, "lead", "SKILL.md"), "utf8")).toBe(bron);
    expect(readFileSync(join(repo, "lead", "SKILL.md"), "utf8")).toBe(bron);
  });
});
