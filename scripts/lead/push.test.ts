import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../test-integriteit";

// push.sh en .githooks/pre-push in een wegwerpmap: een eigen repo met een lokale bare "origin".
// Geen echte remote, geen GIT_*-variabelen van een omringende hook (schoneEnv).

const PUSH = join(import.meta.dir, "push.sh");
const PRE_PUSH = join(import.meta.dir, "..", "..", ".githooks", "pre-push");

let dir: string;
let repo: string;
let origin: string;

const env = (extra: Record<string, string> = {}) => ({
  ...schoneEnv(),
  HOME: dir,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  POORT_OVERSLAAN: "",
  LAB_AGENT_ROL: "",
  ...extra,
});
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: env() });
  return { code: p.exitCode, uit: p.stdout.toString().trim(), fout: p.stderr.toString() };
};
const draai = (args: string[], extra: Record<string, string> = {}, cwd = repo) => {
  const p = Bun.spawnSync(["/bin/bash", "-p", PUSH, ...args], { cwd, env: env(extra), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, uit: p.stdout.toString(), fout: p.stderr.toString() };
};
const opOrigin = (tak: string) => git(origin, "rev-parse", "--verify", "-q", `refs/heads/${tak}`).uit;
const commit = (m: string) => git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", m);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "push-test-")));
  repo = join(dir, "repo");
  origin = join(dir, "origin.git");
  mkdirSync(repo);
  git(dir, "init", "-q", "--bare", origin);
  git(repo, "init", "-q", "-b", "main");
  // vangnet: nooit verdergaan als dit niet de wegwerp-repo is
  expect(git(repo, "rev-parse", "--show-toplevel").uit).toBe(repo);
  // een poort-hook in de repo zelf (push.sh eist hem); hij logt wat hij ziet
  mkdirSync(join(repo, ".githooks"));
  writeFileSync(join(repo, ".githooks", "pre-push"), `#!/bin/sh\necho "draaide:[$POORT_OVERSLAAN]" >> "${dir}/hook.log"\n`);
  chmodSync(join(repo, ".githooks", "pre-push"), 0o755);
  git(repo, "add", ".githooks/pre-push");
  commit("begin");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  // zoals een verse agenttak: upstream wijst naar origin/main
  git(repo, "checkout", "-q", "-b", "lead/x", "--track", "origin/main");
  commit("werk");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("push.sh", () => {
  test("pusht de huidige tak naar origin/<tak> met upstream, ook als de upstream op main stond", () => {
    const r = draai([]);
    expect(r.code).toBe(0);
    expect(opOrigin("lead/x")).toBe(git(repo, "rev-parse", "HEAD").uit);
    expect(opOrigin("main")).not.toBe(git(repo, "rev-parse", "HEAD").uit);
    expect(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}").uit).toBe("origin/lead/x");
  });
  test("`origin` als argument mag, --droog pusht niets", () => {
    const r = draai(["origin", "--droog"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain("git push -u origin refs/heads/lead/x:refs/heads/lead/x");
    expect(opOrigin("lead/x")).toBe("");
  });
  for (const optie of ["-f", "--force", "--force-with-lease", "--force-with-lease=lead/x", "--force-if-includes", "--mirror", "-uf", "+lead/x"])
    test(`weigert force-vorm ${optie}`, () => {
      const r = draai([optie]);
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/force-push mag niet/);
      expect(opOrigin("lead/x")).toBe("");
    });
  test("weigert --no-verify, --delete, een refspec en onbekende opties", () => {
    expect(draai(["--no-verify"]).fout).toMatch(/alleen Brian/);
    expect(draai(["--delete"]).fout).toMatch(/--verwijder/);
    expect(draai(["origin", "lead/x:main"]).fout).toMatch(/geen refspec/);
    expect(draai(["--tags"]).fout).toMatch(/onbekende optie/);
    expect(opOrigin("lead/x")).toBe("");
  });
  test("weigert een andere remote dan origin", () => {
    git(repo, "remote", "add", "ander", origin);
    const r = draai(["ander"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/alleen naar remote 'origin'/);
  });
  test("weigert main en master", () => {
    git(repo, "checkout", "-q", "main");
    expect(draai([]).fout).toMatch(/naar 'main' gaat alles via een PR/);
    git(repo, "checkout", "-q", "-b", "master");
    expect(draai([]).fout).toMatch(/'master'/);
  });
  test("weigert detached HEAD", () => {
    git(repo, "checkout", "-q", "--detach");
    expect(draai([]).fout).toMatch(/detached HEAD/);
  });
  test("weigert een tak die ook in een andere worktree is uitgecheckt", () => {
    const ander = join(dir, "ander");
    expect(git(repo, "worktree", "add", "-q", "--force", ander, "lead/x").code).toBe(0);
    const r = draai([]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/andere worktree/);
    expect(opOrigin("lead/x")).toBe("");
  });
  test("werkt in een eigen worktree van de tak", () => {
    git(repo, "checkout", "-q", "main");
    const wt = join(dir, "wt");
    git(repo, "worktree", "add", "-q", wt, "lead/x");
    expect(draai([], {}, wt).code).toBe(0);
    expect(opOrigin("lead/x")).not.toBe("");
  });
  test("geeft POORT_OVERSLAAN niet door: de pre-push-hook draait en ziet hem niet", () => {
    expect(draai([], { POORT_OVERSLAAN: "1" }).code).toBe(0);
    expect(readFileSync(join(dir, "hook.log"), "utf8").trim()).toBe("draaide:[]");
  });
  test("de hook van de repo draait altijd: core.hooksPath in config of env telt niet", () => {
    const ander = join(dir, "andere-hooks");
    mkdirSync(ander);
    writeFileSync(join(ander, "pre-push"), `#!/bin/sh\necho verkeerd >> "${dir}/hook.log"\n`);
    chmodSync(join(ander, "pre-push"), 0o755);
    git(repo, "config", "core.hooksPath", ander);
    const r = draai([], { GIT_CONFIG_PARAMETERS: `'core.hookspath'='${ander}'`, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: ander });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "hook.log"), "utf8").trim()).toBe("draaide:[]");
  });
  test("weigert zonder uitvoerbare .githooks/pre-push", () => {
    rmSync(join(repo, ".githooks", "pre-push"));
    const r = draai([]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/pre-push ontbreekt/);
    expect(opOrigin("lead/x")).toBe("");
  });
  test("weigert een afwijkende push-URL of een pushInsteadOf", () => {
    const elders = join(dir, "elders.git");
    git(dir, "init", "-q", "--bare", elders);
    git(repo, "remote", "set-url", "--push", "origin", elders);
    expect(draai([]).fout).toMatch(/push-URL van origin/);
    git(repo, "config", "--unset", "remote.origin.pushurl");
    git(repo, "config", `url.${elders}.pushInsteadOf`, origin);
    expect(draai([]).fout).toMatch(/push-URL van origin|pushInsteadOf/);
    git(repo, "config", "--unset", `url.${elders}.pushInsteadOf`);
    git(repo, "config", `url.${elders}.pushInsteadOf`, "https://elders.example/");
    expect(draai([]).fout).toMatch(/pushInsteadOf/);
    expect(opOrigin("lead/x")).toBe("");
  });
});

describe("push.sh --verwijder", () => {
  test("verwijdert een remote tak die in origin/main zit", () => {
    git(repo, "push", "-q", "origin", "lead/x:lead/klaar");
    git(repo, "push", "-q", "origin", "lead/x:main");
    expect(draai(["--verwijder", "lead/klaar", "--droog"]).uit).toContain("--delete refs/heads/lead/klaar");
    expect(opOrigin("lead/klaar")).not.toBe("");
    const r = draai(["--verwijder", "lead/klaar"]);
    expect(r.code).toBe(0);
    expect(opOrigin("lead/klaar")).toBe("");
  });
  test("bij een GitHub-remote en gh: ook een gemergede PR van de tak eisen", () => {
    git(repo, "push", "-q", "origin", "lead/x:lead/klaar");
    git(repo, "push", "-q", "origin", "lead/x:main");
    // origin heet github.com, maar insteadOf stuurt fetch en push naar de lokale bare repo
    git(repo, "config", "remote.origin.url", "git@github.com:o/r.git");
    git(repo, "config", `url.${origin}.insteadOf`, "git@github.com:o/r.git");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "gh $*" >> "${dir}/gh.log"\n[ -f "${dir}/gh-n" ] || exit 1\ncat "${dir}/gh-n"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const pad = { PATH: `${bin}:${process.env.PATH}` };
    expect(draai(["--verwijder", "lead/klaar"], pad).fout).toMatch(/niet opvragen bij o\/r/);
    writeFileSync(join(dir, "gh-n"), "0\n");
    expect(draai(["--verwijder", "lead/klaar"], pad).fout).toMatch(/geen gemergede PR met tak 'lead\/klaar' in o\/r/);
    expect(opOrigin("lead/klaar")).not.toBe("");
    writeFileSync(join(dir, "gh-n"), "1\n");
    expect(draai(["--verwijder", "lead/klaar"], pad).code).toBe(0);
    expect(opOrigin("lead/klaar")).toBe("");
    expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain("pr list --repo o/r --head lead/klaar --state merged");
  });
  test("weigert een tak die niet in origin/main zit", () => {
    git(repo, "push", "-q", "origin", "lead/x:lead/open");
    const r = draai(["--verwijder", "lead/open"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/zit niet in origin\/main/);
    expect(opOrigin("lead/open")).not.toBe("");
  });
  test("weigert main, master, een glob, een onbekende tak en een ontbrekende naam", () => {
    expect(draai(["--verwijder", "main"]).fout).toMatch(/verwijder je nooit/);
    expect(draai(["--verwijder", "master"]).fout).toMatch(/verwijder je nooit/);
    expect(draai(["--verwijder", "lead/*"]).fout).toMatch(/geen glob/);
    expect(draai(["--verwijder", "-f"]).fout).toMatch(/ongeldige taknaam/);
    expect(draai(["--verwijder", "lead/bestaat-niet"]).fout).toMatch(/bestaat niet op origin/);
    expect(draai(["--verwijder"]).fout).toMatch(/mist een taknaam/);
    expect(opOrigin("main")).not.toBe("");
  });
});

describe(".githooks/pre-push", () => {
  const hook = (extra: Record<string, string>) => {
    const p = Bun.spawnSync(["sh", PRE_PUSH], { cwd: repo, env: env({ PATH: `${join(dir, "bin")}:${process.env.PATH}`, ...extra }), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, fout: p.stderr.toString() };
  };
  beforeEach(() => {
    // nep-bun: de echte poort draait hier niet
    mkdirSync(join(dir, "bin"));
    // de stiltevenster-CLI gaat door naar de echte bun, de rest is de nep-poort
    writeFileSync(join(dir, "bin", "bun"), `#!/bin/sh\ncase "$1" in *stiltevenster.ts) exec "${process.execPath}" "$@";; esac\necho "bun $*" >> "${dir}/bun.log"\nexit 0\n`);
    chmodSync(join(dir, "bin", "bun"), 0o755);
  });
  test("weigert POORT_OVERSLAAN in een agentsessie (LAB_AGENT_ROL)", () => {
    const r = hook({ POORT_OVERSLAAN: "1", LAB_AGENT_ROL: "agent" });
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/Alleen Brian mag de poort overslaan/);
  });
  test("Brian (zonder LAB_AGENT_ROL) mag POORT_OVERSLAAN", () => {
    const r = hook({ POORT_OVERSLAAN: "1" });
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/poort overgeslagen/);
  });
  test("zonder POORT_OVERSLAAN draait de poort, ook voor een agent", () => {
    expect(hook({ LAB_AGENT_ROL: "agent", STILTEVENSTER_NU: "2026-10-18T10:00:00Z" }).code).toBe(0);
    expect(readFileSync(join(dir, "bun.log"), "utf8")).toContain("bun run check");
  });
  describe("logbestand van de poort", () => {
    const map = () => join(repo, ".git", "lab-poort");
    // nep-poort die rood is; met schrijf=1 zet hij het pad in lab-poort/laatste zoals scripts/poort-log.ts
    const nepRood = (schrijf: boolean) => {
      writeFileSync(
        join(dir, "bin", "bun"),
        `#!/bin/sh\ncase "$1" in *stiltevenster.ts) exec "${process.execPath}" "$@";; esac\n${
          schrijf ? `mkdir -p "${map()}" && echo "${map()}/abc1234-nep.log" > "${map()}/laatste"\n` : ""
        }exit 1\n`,
      );
    };
    test("een rode poort: de weigering noemt het pad uit lab-poort/laatste", () => {
      nepRood(true);
      const r = hook({});
      expect(r.code).toBe(1);
      expect(r.fout).toContain(`Volledige uitvoer: ${map()}/abc1234-nep.log`);
    });
    test("een oud pad uit een eerdere run wordt niet genoemd als de poort niets schreef", () => {
      mkdirSync(map(), { recursive: true });
      writeFileSync(join(map(), "laatste"), `${map()}/oud.log\n`);
      nepRood(false);
      const r = hook({});
      expect(r.code).toBe(1);
      expect(r.fout).not.toContain("oud.log");
      expect(r.fout).toMatch(/geen logbestand gevonden/);
    });
  });
  describe("stiltevenster", () => {
    const IN = { STILTEVENSTER_NU: "2026-10-18T03:30:00Z" };
    const BUITEN = { STILTEVENSTER_NU: "2026-10-18T05:15:00Z" };
    test("weigert een agent (LAB_AGENT_ROL) in het venster, zonder de poort te draaien", () => {
      const r = hook({ LAB_AGENT_ROL: "agent", ...IN });
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/stiltevenster 05:00–07:15, geen push vanuit een agentsessie/);
      expect(existsSync(join(dir, "bun.log"))).toBe(false);
    });
    test("Brian (zonder LAB_AGENT_ROL) mag in het venster door tot aan de poort", () => {
      expect(hook(IN).code).toBe(0);
      expect(readFileSync(join(dir, "bun.log"), "utf8")).toContain("bun run check");
    });
    test("een agent buiten het venster komt door tot aan de poort", () => {
      expect(hook({ LAB_AGENT_ROL: "agent", ...BUITEN }).code).toBe(0);
      expect(readFileSync(join(dir, "bun.log"), "utf8")).toContain("bun run check");
    });
  });
});
