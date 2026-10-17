import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../test-integriteit";
import { BESTANDEN, BRON_IN_REPO, commandos, controleer, heeftAcl, verwachteShas } from "./installeer-grens";

// installeer-grens.ts in een wegwerpmap: een eigen git-repo met refs/remotes/origin/main als bron
// (--repo, --zonder-fetch) en een tijdelijke doelmap met de eigen uid als "eigenaar". Nooit sudo:
// een nep-sudo vooraan op PATH bewijst dat het script hem niet aanroept.

const SCRIPT = join(import.meta.dir, "installeer-grens.ts");
const uid = process.getuid?.() ?? 0;
let dir: string;
let repo: string;
let bron: string;
let doel: string;

const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { env: schoneEnv(), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};
const draai = (...args: string[]) => {
  const bin = join(dir, "bin");
  const p = Bun.spawnSync(["bun", SCRIPT, "--repo", repo, "--zonder-fetch", ...args], {
    env: { ...schoneEnv(), PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, uit: p.stdout.toString(), err: p.stderr.toString() };
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "installeer-grens-")));
  repo = join(dir, "repo");
  bron = join(repo, BRON_IN_REPO);
  mkdirSync(bron, { recursive: true });
  for (const naam of Object.keys(BESTANDEN)) copyFileSync(join(import.meta.dir, naam), join(bron, naam));
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  doel = join(dir, "lab-lead");
  mkdirSync(doel);
  chmodSync(doel, 0o755);
  for (const [naam, modus] of Object.entries(BESTANDEN)) {
    copyFileSync(join(bron, naam), join(doel, naam));
    chmodSync(join(doel, naam), modus);
  }
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "sudo $*" >> "${dir}/sudo.log"\n`);
  chmodSync(join(bin, "sudo"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("installeer-grens.ts", () => {
  test("installeert alleen merge.sh en lead.conf", () => {
    expect(Object.keys(BESTANDEN).sort()).toEqual(["lead.conf", "merge.sh"]);
  });
  test("print de sudo-commando's (root:wheel, 755/644) en de shasum-controle, en voert zelf niets uit", () => {
    const r = draai();
    expect(r.code).toBe(0);
    expect(r.uit).toContain("sudo install -d -o root -g wheel -m 755 '/usr/local/lib/lab-lead'");
    expect(r.uit).toContain(`sudo install -o root -g wheel -m 755 '${join(bron, "merge.sh")}' '/usr/local/lib/lab-lead/merge.sh'`);
    expect(r.uit).toContain(`-m 644 '${join(bron, "lead.conf")}' '/usr/local/lib/lab-lead/lead.conf'`);
    expect(r.uit).not.toContain("push.sh");
    expect(r.uit).not.toContain("lab-lees.sh");
    expect(r.uit).toContain("shasum -a 256 /usr/local/lib/lab-lead/*");
    const v = verwachteShas(repo, false);
    expect(r.uit).toContain(`${v["merge.sh"]}  /usr/local/lib/lab-lead/merge.sh`);
    expect(existsSync(join(dir, "sudo.log"))).toBe(false);
  });
  test("weigert te printen als de werkkopie afwijkt van origin/main", () => {
    writeFileSync(join(bron, "merge.sh"), "#!/bin/sh\nexit 0\n");
    const r = draai();
    expect(r.code).toBe(1);
    expect(r.err).toContain("merge.sh");
    expect(r.err).toContain("wijkt af van origin/main");
    expect(r.uit).not.toContain("sudo install");
  });
  test("quote een bronpad met een spatie of quote", () => {
    expect(commandos("/a b/it's", "/d")[1]).toBe(`sudo install -o root -g wheel -m 755 '/a b/it'\\''s/merge.sh' '/d/merge.sh'`);
  });
  test("--controleer: OK bij gelijke sha's, eigenaar en modus", () => {
    const u = controleer(verwachteShas(repo, false), doel, uid, dir);
    expect(u.regels.filter((r) => r.startsWith("FOUT"))).toEqual([]);
    expect(u.ok).toBe(true);
    expect(draai("--controleer", "--doel", doel, "--eigenaar", String(uid), "--testwortel", dir).code).toBe(0);
  });
  test("--controleer vergelijkt met origin/main, niet met de werkkopie", () => {
    // werkkopie en geïnstalleerde kopie gelijk aangepast: toch FOUT
    for (const p of [join(bron, "merge.sh"), join(doel, "merge.sh")]) writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(join(doel, "merge.sh"), 0o755);
    const r = draai("--controleer", "--doel", doel, "--eigenaar", String(uid), "--testwortel", dir);
    expect(r.code).toBe(1);
    expect(r.uit).toMatch(/merge\.sh: sha256 .* wijkt af van origin\/main/);
  });
  test("--controleer: FOUT bij een andere inhoud, modus, eigenaar, symlink of ontbrekend bestand", () => {
    const v = verwachteShas(repo, false);
    writeFileSync(join(doel, "merge.sh"), "#!/bin/sh\nexit 0\n");
    rmSync(join(doel, "lead.conf"));
    symlinkSync(join(bron, "lead.conf"), join(doel, "lead.conf"));
    let tekst = controleer(v, doel, uid, dir).regels.join("\n");
    expect(tekst).toMatch(/merge\.sh: sha256 .* wijkt af/);
    expect(tekst).toMatch(/lead\.conf: is een symlink/);
    chmodSync(join(doel, "merge.sh"), 0o775);
    rmSync(join(doel, "lead.conf"));
    tekst = controleer(v, doel, uid, dir).regels.join("\n");
    expect(tekst).toMatch(/merge\.sh: schrijfbaar voor groep of anderen/);
    expect(tekst).toMatch(/lead\.conf: ontbreekt/);
    expect(controleer(v, doel, uid + 1, dir).regels.join("\n")).toMatch(/eigenaar uid/);
  });
  test("--controleer: FOUT bij een schrijfbare doelmap of een ontbrekend doel", () => {
    const v = verwachteShas(repo, false);
    chmodSync(doel, 0o777);
    expect(controleer(v, doel, uid, dir).regels.join("\n")).toMatch(/schrijfbaar voor groep of anderen/);
    expect(controleer(v, join(dir, "nergens"), uid, dir).regels.join("\n")).toMatch(/bestaat niet/);
  });
  test("--controleer: FOUT bij een symlink in het pad of een schrijfbare voorouder", () => {
    const v = verwachteShas(repo, false);
    const link = join(dir, "link");
    symlinkSync(dir, link);
    expect(controleer(v, join(link, "lab-lead"), uid, dir).regels.join("\n")).toMatch(/echte pad is/);
    chmodSync(dir, 0o777);
    try {
      expect(controleer(v, doel, uid, dir).regels.join("\n")).toMatch(/voorouder .*schrijfbaar voor groep of anderen/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
  test("buiten macOS: getfacl als die er is, anders een LET OP-melding in plaats van een FOUT", () => {
    expect([null, false]).toContain(heeftAcl(doel, "linux"));
  });
  // test-weg: ACL bestaat alleen op macOS (CI is ubuntu)
  test.skipIf(process.platform !== "darwin")("--controleer: FOUT bij een ACL op de map of een bestand", () => {
    const v = verwachteShas(repo, false);
    expect(heeftAcl(doel)).toBe(false);
    const p = Bun.spawnSync(["/bin/chmod", "+a", "everyone allow write", join(doel, "merge.sh")]);
    expect(p.exitCode).toBe(0);
    expect(heeftAcl(join(doel, "merge.sh"))).toBe(true);
    expect(controleer(v, doel, uid, dir).regels.join("\n")).toMatch(/merge\.sh: heeft een ACL/);
  });
});
