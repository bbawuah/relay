import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BESTANDEN, commandos, controleer } from "./installeer-grens";

// installeer-grens.ts in een wegwerpmap: het doel is een tijdelijke map met de eigen uid als
// "eigenaar". Nooit sudo: een nep-sudo vooraan op PATH bewijst dat het script hem niet aanroept.

const BRON = import.meta.dir;
const SCRIPT = join(import.meta.dir, "installeer-grens.ts");
const uid = process.getuid?.() ?? 0;
let dir: string;
let doel: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installeer-grens-"));
  doel = join(dir, "lab-lead");
  mkdirSync(doel);
  chmodSync(doel, 0o755);
  for (const [naam, modus] of Object.entries(BESTANDEN)) {
    copyFileSync(join(BRON, naam), join(doel, naam));
    chmodSync(join(doel, naam), modus);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("installeer-grens.ts", () => {
  test("print de sudo-commando's (root:wheel, 755/644) en voert zelf niets uit", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "sudo $*" >> "${dir}/sudo.log"\n`);
    chmodSync(join(bin, "sudo"), 0o755);
    const p = Bun.spawnSync(["bun", SCRIPT], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const uit = p.stdout.toString();
    expect(uit).toContain("sudo install -d -o root -g wheel -m 755 '/usr/local/lib/lab-lead'");
    expect(uit).toContain(`sudo install -o root -g wheel -m 755 '${join(BRON, "merge.sh")}' '/usr/local/lib/lab-lead/merge.sh'`);
    expect(uit).toContain(`-m 644 '${join(BRON, "lead.conf")}' '/usr/local/lib/lab-lead/lead.conf'`);
    for (const naam of ["push.sh", "lab-lees.sh"]) expect(uit).toContain(`/usr/local/lib/lab-lead/${naam}'`);
    expect(existsSync(join(dir, "sudo.log"))).toBe(false);
  });
  test("quote een bronpad met een spatie of quote", () => {
    expect(commandos("/a b/it's", "/d")[1]).toBe(`sudo install -o root -g wheel -m 755 '/a b/it'\\''s/merge.sh' '/d/merge.sh'`);
  });
  test("--controleer: OK bij gelijke sha's, eigenaar en modus", () => {
    const u = controleer(BRON, doel, uid);
    expect(u.regels.filter((r) => r.startsWith("FOUT"))).toEqual([]);
    expect(u.ok).toBe(true);
    const p = Bun.spawnSync(["bun", SCRIPT, "--controleer", "--doel", doel, "--eigenaar", String(uid)], { stdout: "pipe" });
    expect(p.exitCode).toBe(0);
  });
  test("--controleer: FOUT bij een andere inhoud, modus, eigenaar, symlink of ontbrekend bestand", () => {
    writeFileSync(join(doel, "push.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(doel, "merge.sh"), 0o775);
    rmSync(join(doel, "lab-lees.sh"));
    rmSync(join(doel, "lead.conf"));
    symlinkSync(join(BRON, "lead.conf"), join(doel, "lead.conf"));
    const u = controleer(BRON, doel, uid);
    expect(u.ok).toBe(false);
    const tekst = u.regels.join("\n");
    expect(tekst).toMatch(/push\.sh: sha256 .* wijkt af/);
    expect(tekst).toMatch(/merge\.sh: schrijfbaar voor groep of anderen/);
    expect(tekst).toMatch(/lab-lees\.sh: ontbreekt/);
    expect(tekst).toMatch(/lead\.conf: is een symlink/);
    expect(controleer(BRON, doel, uid + 1).regels.join("\n")).toMatch(/eigenaar uid/);
    const p = Bun.spawnSync(["bun", SCRIPT, "--controleer", "--doel", doel, "--eigenaar", String(uid)], { stdout: "pipe" });
    expect(p.exitCode).toBe(1);
  });
  test("--controleer: FOUT bij een schrijfbare doelmap of een ontbrekend doel", () => {
    chmodSync(doel, 0o777);
    expect(controleer(BRON, doel, uid).regels.join("\n")).toMatch(/schrijfbaar voor groep of anderen/);
    expect(controleer(BRON, join(dir, "nergens"), uid).regels.join("\n")).toMatch(/bestaat niet/);
  });
});
