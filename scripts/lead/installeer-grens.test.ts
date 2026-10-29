import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../test-integriteit";
import { valideerSleutels } from "./commando/sleutels";
import {
  apparaatVan,
  BESTANDEN,
  BRON_IN_REPO,
  bouwRunner,
  commandos,
  controleer,
  exporteerSleutels,
  heeftAcl,
  heeftRunner,
  PLIST_SJABLOON,
  RUNNER,
  RUNNER_BRON,
  SLEUTELS,
  verwacht,
  verwachteShas,
} from "./installeer-grens";

// installeer-grens.ts in een wegwerpmap: een eigen git-repo met refs/remotes/origin/main als bron
// (--repo, --zonder-fetch) en een tijdelijke doelmap met de eigen uid als "eigenaar". Nooit sudo:
// een nep-sudo vooraan op PATH bewijst dat het script hem niet aanroept.

const SCRIPT = join(import.meta.dir, "installeer-grens.ts");

test("de vaste installer biedt geen mergepolicybestanden meer aan", () => {
  expect(BESTANDEN).toEqual({});
  const regels = commandos("/repo", "/doel", "/runner met spatie");
  expect(regels).toEqual([
    "sudo install -d -o root -g wheel -m 755 '/doel'",
    "sudo install -o root -g wheel -m 755 '/runner met spatie' '/doel/commando-runner.js'",
  ]);
  expect(draai().code).toBe(0);
  expect(existsSync(join(dir, "sudo.log"))).toBe(false);
});

test("runnercontrole behoudt inhoud, modus, eigenaar, symlink- en ontbrekend-bestandchecks", () => {
  const pad = join(doel, RUNNER);
  writeFileSync(pad, "runner", { mode: 0o755 });
  const shas = { [RUNNER]: createHash("sha256").update("runner").digest("hex") };
  const regels = () => controleer(shas, doel, uid, dir).regels.join("\n");
  expect(regels()).toContain("passkeys.pub: ontbreekt");
  writeFileSync(pad, "anders");
  expect(regels()).toContain("wijkt af van origin/main");
  chmodSync(pad, 0o644);
  expect(regels()).toContain("modus 644, verwacht 755");
  chmodSync(pad, 0o775);
  expect(regels()).toContain("schrijfbaar voor groep of anderen");
  expect(controleer(shas, doel, uid + 1, dir).regels.join("\n")).toContain("eigenaar uid");
  rmSync(pad);
  symlinkSync(join(dir, "bestand"), pad);
  writeFileSync(join(dir, "bestand"), "runner");
  expect(regels()).toContain("is een symlink");
  rmSync(pad);
  expect(regels()).toContain("commando-runner.js: ontbreekt");
});
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
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "x");
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

  test("--controleer: OK bij gelijke sha's, eigenaar en modus", () => {
    const u = controleer(verwachteShas(repo, false), doel, uid, dir);
    expect(u.regels.filter((r) => r.startsWith("FOUT"))).toEqual([]);
    expect(u.ok).toBe(true);
    expect(draai("--controleer", "--doel", doel, "--eigenaar", String(uid), "--testwortel", dir).code).toBe(0);
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
    writeFileSync(join(doel, RUNNER), "runner");
    chmodSync(join(doel, RUNNER), 0o755);
    const v = { [RUNNER]: createHash("sha256").update("runner").digest("hex") };
    expect(heeftAcl(doel)).toBe(false);
    const p = Bun.spawnSync(["/bin/chmod", "+a", "everyone allow write", join(doel, RUNNER)]);
    expect(p.exitCode).toBe(0);
    expect(heeftAcl(join(doel, RUNNER))).toBe(true);
    expect(controleer(v, doel, uid, dir).regels.join("\n")).toMatch(/commando-runner\.js: heeft een ACL/);
  });
});

describe("installeer-grens.ts: de commando-runner", () => {
  // De wegwerp-repo krijgt een kleine runner.ts (zonder dependencies) en het plist-sjabloon; de bundel
  // wordt echt gebouwd met bun build uit refs/remotes/origin/main.
  const sjabloon = () => readFileSync(join(import.meta.dir, "commando", "nl.lab-b.commando.plist.sjabloon"), "utf8");
  let plist: string;
  const sleutels = { versie: 1, rpID: "mini.tail1234.ts.net", origins: ["https://mini.tail1234.ts.net"], sleutels: [{ credentialId: "Y3JlZA", publicKey: "cHVibGllaw", apparaat: "iPhone 2026-10-01" }] };
  const draaiThuis = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", SCRIPT, "--repo", repo, "--zonder-fetch", ...args], {
      env: { ...schoneEnv(), HOME: dir, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, uit: p.stdout.toString(), err: p.stderr.toString() };
  };
  const installeer = () => {
    const v = verwacht(repo, false, dir);
    copyFileSync(v.runner!.pad, join(doel, RUNNER));
    chmodSync(join(doel, RUNNER), 0o755);
    writeFileSync(join(doel, SLEUTELS), JSON.stringify(sleutels));
    chmodSync(join(doel, SLEUTELS), 0o644);
    writeFileSync(plist, v.plist!);
    return v;
  };
  const controleerAlles = (v: ReturnType<typeof verwacht>) => controleer(v.shas, doel, uid, dir, { plist: v.plist!, plistPad: plist, bun: v.runner!.bun });

  beforeEach(() => {
    mkdirSync(join(repo, "scripts/lead/commando"), { recursive: true });
    writeFileSync(join(repo, RUNNER_BRON), 'console.log("runner");\n');
    writeFileSync(join(repo, PLIST_SJABLOON), sjabloon());
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "runner");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    plist = join(dir, "nl.lab-b.commando.plist");
  });

  test("zonder runner in origin/main worden geen mergepolicybestanden aangeboden", () => {
    git("update-ref", "refs/remotes/origin/main", "HEAD~1");
    expect(heeftRunner(repo)).toBe(false);
    expect(Object.keys(verwacht(repo, false).shas).sort()).toEqual([]);
  });
  test("bouwt de bundel uit origin/main, twee keer dezelfde sha", () => {
    const a = bouwRunner(repo);
    const b = bouwRunner(repo);
    expect(a.sha).toBe(b.sha);
    expect(readFileSync(a.pad, "utf8")).toContain('console.log("runner")');
  });
  test("een archief groter dan 16 MB (zoals de echte repo, 23,7 MB) bouwt gewoon", () => {
    // willekeurige bytes comprimeren niet: het tar-archief is dan echt groter dan de oude buffer van 16 MB
    writeFileSync(join(repo, "groot.bin"), randomBytes(17 * 1024 * 1024));
    git("add", "groot.bin");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "groot");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(readFileSync(bouwRunner(repo).pad, "utf8")).toContain('console.log("runner")');
  });
  test("bouwt uit origin/main, niet uit de werkkopie", () => {
    const voor = bouwRunner(repo).sha;
    writeFileSync(join(repo, RUNNER_BRON), 'console.log("kwaad");\n');
    expect(bouwRunner(repo).sha).toBe(voor);
  });
  test("print de installatie van de bundel en de LaunchAgent met HOME ingevuld, en voert niets uit", () => {
    const r = draaiThuis();
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/sudo install -o root -g wheel -m 755 '[^']*commando-runner\.js' '\/usr\/local\/lib\/lab-lead\/commando-runner\.js'/);
    expect(r.uit).toContain(`#|     <string>${dir}/.local/state/lab-commando/akkoord</string>`);
    expect(r.uit).toContain("#|     <string>--live</string>");
    expect(r.uit).not.toContain("{{HOME}}");
    expect(existsSync(join(dir, "sudo.log"))).toBe(false);
    // INSTALLEREN.md: `… | sed -n 's/^#| //p' > plist` levert precies wat --controleer verwacht
    const uitSed = r.uit.split("\n").flatMap((l) => (l.startsWith("#| ") ? [l.slice(3)] : []));
    expect(`${uitSed.join("\n")}\n`).toBe(verwacht(repo, false, dir).plist!);
  });
  test("--controleer: OK met bundel, passkeys.pub en LaunchAgent", () => {
    const v = installeer();
    const u = controleerAlles(v);
    expect(u.regels.filter((r) => r.startsWith("FOUT"))).toEqual([]);
    expect(u.regels.join("\n")).toMatch(/passkeys\.pub sha256 [0-9a-f]{12} \(1 sleutel; vergelijk met de passkeys in Terminal B\)/);
    expect(u.regels).toContain("       Y3JlZA  iPhone 2026-10-01");
    const r = draaiThuis("--controleer", "--doel", doel, "--eigenaar", String(uid), "--testwortel", dir, "--plist", plist);
    expect(r.uit).not.toContain("FOUT");
    expect(r.code).toBe(0);
  });
  test("--controleer: een andere bundel noemt de bun-versie", () => {
    const v = installeer();
    writeFileSync(join(doel, RUNNER), "// oud\n");
    expect(controleerAlles(v).regels.join("\n")).toMatch(new RegExp(`commando-runner\\.js: sha256 .* wijkt af van origin/main .*bun ${Bun.version.replaceAll(".", "\\.")}`));
  });
  test("--controleer: passkeys.pub ontbreekt, is ongeldig of schrijfbaar voor anderen", () => {
    const v = installeer();
    writeFileSync(join(doel, SLEUTELS), JSON.stringify({ ...sleutels, privateKey: "x" }));
    expect(controleerAlles(v).regels.join("\n")).toMatch(/passkeys\.pub: passkeys\.pub: onbekende sleutel privateKey/);
    chmodSync(join(doel, SLEUTELS), 0o666);
    expect(controleerAlles(v).regels.join("\n")).toMatch(/passkeys\.pub: schrijfbaar voor groep of anderen/);
    rmSync(join(doel, SLEUTELS));
    expect(controleerAlles(v).regels.join("\n")).toMatch(/passkeys\.pub: ontbreekt; zie .*INSTALLEREN\.md/);
  });
  test("--controleer: LaunchAgent ontbreekt of wijkt af (bv. een andere runner)", () => {
    const v = installeer();
    writeFileSync(plist, v.plist!.replace("/usr/local/lib/lab-lead/commando-runner.js", `${dir}/kwaad.js`));
    expect(controleerAlles(v).regels.join("\n")).toMatch(/wijkt af van het sjabloon/);
    rmSync(plist);
    expect(controleerAlles(v).regels.join("\n")).toMatch(/nl\.lab-b\.commando\.plist: ontbreekt/);
  });

  describe("--sleutels-export (alleen Brian; hier een nep-opslag)", () => {
    const opslag = () => {
      const p = join(dir, "passkeys-nep.json");
      writeFileSync(p, JSON.stringify({ passkeys: [{ login: "brian@x", id: "Y3JlZA", publicKey: "cHVibGllaw", counter: 7, naam: "iPhone", aangemaakt: "2026-10-01" }] }));
      return p;
    };
    const ander = { login: "agent@x", id: "a3dhYWQ", publicKey: "a3dhYWRwdWI", counter: 1, naam: "Laptop agent", aangemaakt: "2026-10-20T09:00:00Z" };
    const tweede = { login: "brian@x", id: "dHdlZWRlLWlk", publicKey: "dHdlZWRl", counter: 3, naam: "MacBook van Brian’s", aangemaakt: "2026-10-15T08:00:00Z" };
    const meer = () => {
      const p = join(dir, "passkeys-meer.json");
      writeFileSync(p, JSON.stringify({ passkeys: [ander, JSON.parse(readFileSync(opslag(), "utf8")).passkeys[0], tweede] }));
      return p;
    };
    test("alleen de passkeys van de login; credential-id, publieke sleutel en apparaat (naam, datum); modus 600", () => {
      const uit = join(dir, "passkeys.pub");
      const r = exporteerSleutels(meer(), uit, "mini.tail1234.ts.net", ["https://mini.tail1234.ts.net"], "brian@x");
      expect(r.sleutels.sleutels).toEqual([sleutels.sleutels[0]!, { credentialId: "dHdlZWRlLWlk", publicKey: "dHdlZWRl", apparaat: "MacBook van Brian?s 2026-10-15" }]);
      const tekst = readFileSync(uit, "utf8");
      for (const w of ["brian@x", "agent@x", "a3dhYWQ", "counter", "aangemaakt", "login"]) expect(tekst).not.toContain(w);
      expect(statSync(uit).mode & 0o777).toBe(0o600);
      expect(r.overzicht).toEqual(["Y3JlZA  iPhone 2026-10-01", "dHdlZWRl  MacBook van Brian?s 2026-10-15"]);
      expect(r.sha256).toBe(createHash("sha256").update(readFileSync(uit)).digest("hex"));
      expect(r.regels).toEqual([`sudo install -o root -g wheel -m 644 '${uit}' '/usr/local/lib/lab-lead/passkeys.pub'`, `rm '${uit}'`]);
    });
    test("apparaat: zonder naam of datum, en een lange naam blijft binnen 64 tekens", () => {
      expect(apparaatVan(undefined, undefined)).toBe("zonder naam zonder-datum");
      expect(apparaatVan("x".repeat(100), "2026-10-01").length).toBe(64);
      expect(valideerSleutels({ ...sleutels, sleutels: [{ ...sleutels.sleutels[0]!, apparaat: apparaatVan("x".repeat(100), "2026-10-01") }] })).toBeTruthy();
    });
    test("weigert een bestaand uitvoerbestand, een verkeerde origin, een kapotte opslag of een login zonder passkeys", () => {
      const uit = join(dir, "passkeys.pub");
      writeFileSync(uit, "al daar");
      expect(() => exporteerSleutels(opslag(), uit, "mini.tail1234.ts.net", ["https://mini.tail1234.ts.net"], "brian@x")).toThrow(/EEXIST/);
      expect(() => exporteerSleutels(opslag(), join(dir, "b.pub"), "mini.tail1234.ts.net", ["http://mini.tail1234.ts.net"], "brian@x")).toThrow(/origin/);
      writeFileSync(join(dir, "kapot.json"), JSON.stringify({ iets: [] }));
      expect(() => exporteerSleutels(join(dir, "kapot.json"), join(dir, "c.pub"), "mini.tail1234.ts.net", ["https://mini.tail1234.ts.net"], "brian@x")).toThrow(/geen lijst/);
      expect(() => exporteerSleutels(meer(), join(dir, "d.pub"), "mini.tail1234.ts.net", ["https://mini.tail1234.ts.net"], "niemand@x")).toThrow(/geen passkeys voor login niemand@x/);
      expect(existsSync(join(dir, "d.pub"))).toBe(false);
    });
    test("CLI: print de sudo-regel en het wissen, en voert niets uit", () => {
      const uit = join(dir, "export.pub");
      const r = draaiThuis("--sleutels-export", uit, "--login", "brian@x", "--rpid", "mini.tail1234.ts.net", "--origin", "https://mini.tail1234.ts.net", "--passkeys", opslag());
      expect(r.err).toBe("");
      expect(r.uit).toContain("# 1 publieke sleutel van brian@x");
      expect(r.uit).toContain("#   Y3JlZA  iPhone 2026-10-01");
      expect(r.uit).toContain(`# sha256 ${createHash("sha256").update(readFileSync(uit)).digest("hex")}  (na de installatie: shasum -a 256 /usr/local/lib/lab-lead/passkeys.pub)`);
      expect(r.uit).toContain(`rm '${uit}'`);
      expect(existsSync(join(dir, "sudo.log"))).toBe(false);
      expect(draaiThuis("--sleutels-export", join(dir, "y.pub"), "--login", "brian@x", "--rpid", "x").err).toMatch(/vraagt --origin/);
      expect(draaiThuis("--sleutels-export", join(dir, "z.pub"), "--rpid", "x").err).toMatch(/vraagt --login/);
    });
  });
});
