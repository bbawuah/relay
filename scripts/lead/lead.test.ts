import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Alle tests draaien de scripts met een nep-gh en nep-tmux vooraan op PATH, in een
// wegwerpmap met een eigen git-repo en lokale bare "origin". Geen echte tmux, geen echte PR's.

const SPAWN = join(import.meta.dir, "spawn.sh");
const MERGE = join(import.meta.dir, "merge.sh");

let dir: string;
let bin: string;
let repo: string;
let origin: string;

const schrijfBin = (naam: string, tekst: string) => {
  const pad = join(bin, naam);
  writeFileSync(pad, tekst);
  chmodSync(pad, 0o755);
};

// Draait de test in een git-hook (pre-push), dan staan GIT_DIR e.d. in de omgeving en zouden
// de git-aanroepen hieronder de echte repo raken. Daarom: alle GIT_*-variabelen eruit.
const schoon = (): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) e[k] = v;
  return { ...e, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
};

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: schoon() });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-test-"));
  bin = join(dir, "bin");
  repo = join(dir, "repo");
  origin = join(dir, "origin.git");
  mkdirSync(bin);
  mkdirSync(repo);

  // nep-gh: pr view geeft pr.json; pr merge logt en zet (optioneel) de staat op MERGED.
  schrijfBin(
    "gh",
    `#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_DIR/gh.log"
if [ "$1 $2" = "pr view" ]; then
  [ -f "$FAKE_DIR/gh-faalt" ] && exit 1
  cat "$FAKE_DIR/pr.json"; exit 0
fi
if [ "$1 $2" = "pr merge" ]; then
  [ -f "$FAKE_DIR/merge-werkt" ] && sed -i.bak 's/"state":"OPEN"/"state":"MERGED"/' "$FAKE_DIR/pr.json"
  exit 0
fi
echo "nep-gh: onverwacht commando $*" >&2; exit 2
`,
  );

  // nep-tmux: log elke aanroep; capture-pane toont het bestand pane.txt;
  // send-keys ... Enter laat (als reageert) een tool-aanroep verschijnen.
  schrijfBin(
    "tmux",
    `#!/usr/bin/env bash
echo "tmux $*" >> "$FAKE_DIR/tmux.log"
case $1 in
  capture-pane) cat "$FAKE_DIR/pane.txt" 2>/dev/null; exit 0 ;;
  send-keys)
    if [ "\${*: -1}" = "Enter" ] && [ -f "$FAKE_DIR/reageert" ]; then echo "⏺ Read(opdracht.md)" >> "$FAKE_DIR/pane.txt"; fi
    exit 0 ;;
esac
exit 0
`,
  );

  // nep-agent-spawn: print een pane-id.
  schrijfBin("nep-agent-spawn.sh", `#!/usr/bin/env bash\necho "spawn $*" >> "$FAKE_DIR/spawn.log"\necho "bijvangst"\necho "%7"\n`);

  git(dir, "init", "-q", "--bare", origin);
  git(repo, "init", "-q", "-b", "main");
  // vangnet: nooit verdergaan als dit niet de wegwerp-repo is
  expect(git(repo, "rev-parse", "--git-dir").stdout.toString().trim()).toBe(".git");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "begin");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "main:lead/test-tak");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omgeving = (extra: Record<string, string> = {}) => ({
  ...schoon(),
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_DIR: dir,
  TMUX: "",
  TMUX_PANE: "",
  ...extra,
});

const draai = (script: string, args: string[], extra: Record<string, string> = {}, cwd = repo) => {
  const r = Bun.spawnSync(["bash", script, ...args], { cwd, env: omgeving(extra) });
  return { code: r.exitCode, uit: r.stdout.toString(), fout: r.stderr.toString() };
};

const log = (naam: string) => (existsSync(join(dir, naam)) ? readFileSync(join(dir, naam), "utf8") : "");
const remoteTakken = () => git(repo, "ls-remote", "--heads", "origin").stdout.toString();

describe("merge.sh", () => {
  const pr = (o: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, "pr.json"),
      JSON.stringify({
        state: "OPEN",
        headRefName: "lead/test-tak",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        comments: [{ body: "Lead-review: akkoord, ziet er goed uit" }],
        statusCheckRollup: [{ name: "poort", conclusion: "SUCCESS", status: "COMPLETED" }],
        ...o,
      }),
    );
  const geweigerd = (r: { code: number; fout: string }, reden: RegExp) => {
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(reden);
    expect(log("gh.log")).not.toContain("pr merge");
    expect(remoteTakken()).toContain("lead/test-tak");
  };

  test("weigert zonder nummer of met een vreemd nummer", () => {
    pr();
    expect(draai(MERGE, []).code).toBe(1);
    expect(draai(MERGE, ["abc"]).fout).toMatch(/PR-nummer/);
  });

  test("weigert zonder Lead-review-comment", () => {
    pr({ comments: [{ body: "ziet er goed uit" }, { body: "ik: Lead-review: akkoord (niet aan het begin)" }] });
    geweigerd(draai(MERGE, ["71"]), /Lead-review: akkoord/);
  });

  test("weigert als de check poort niet groen is", () => {
    pr({ statusCheckRollup: [{ name: "poort", conclusion: "FAILURE" }] });
    geweigerd(draai(MERGE, ["71"]), /niet groen/);
  });

  test("weigert als de check poort ontbreekt (een andere check groen telt niet)", () => {
    pr({ statusCheckRollup: [{ name: "lint", conclusion: "SUCCESS" }] });
    geweigerd(draai(MERGE, ["71"]), /'poort' staat niet/);
  });

  test("weigert als de PR niet mergeable is", () => {
    pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    geweigerd(draai(MERGE, ["71"]), /niet mergeable/);
  });

  test("weigert als de tak achterloopt (strict)", () => {
    pr({ mergeStateStatus: "BEHIND" });
    geweigerd(draai(MERGE, ["71"]), /achter/);
  });

  test("weigert een PR die al gemerged is", () => {
    pr({ state: "MERGED" });
    geweigerd(draai(MERGE, ["71"]), /MERGED/);
  });

  test("weigert als gh de PR niet kan ophalen", () => {
    pr();
    writeFileSync(join(dir, "gh-faalt"), "");
    geweigerd(draai(MERGE, ["71"]), /niet op te halen/);
  });

  test("--droog merget niets", () => {
    pr();
    const r = draai(MERGE, ["71", "--droog"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain("droog");
    expect(log("gh.log")).not.toContain("pr merge");
    expect(remoteTakken()).toContain("lead/test-tak");
  });

  test("merget met --merge en verwijdert pas daarna de remote tak", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(0);
    expect(log("gh.log")).toContain("gh pr merge 71 --merge");
    expect(remoteTakken()).not.toContain("lead/test-tak");
    expect(remoteTakken()).toContain("refs/heads/main");
  });

  test("laat de remote tak staan als de PR na het mergen niet MERGED is", () => {
    pr(); // merge-werkt ontbreekt: de staat blijft OPEN
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet MERGED/);
    expect(remoteTakken()).toContain("lead/test-tak");
  });
});

describe("spawn.sh", () => {
  const opdracht = () => {
    const p = join(dir, "opdracht.md");
    writeFileSync(p, "doe iets\n");
    return p;
  };
  const basis = (extra: Record<string, string> = {}) => ({
    LAB_SPAWN_SCRIPT: join(bin, "nep-agent-spawn.sh"),
    LAB_SPAWN_POLS: "0",
    LAB_SPAWN_WACHT: "0",
    LAB_SPAWN_BEWIJS: "0",
    LAB_LEAD_NAAM: "",
    ...extra,
  });

  test("weigert zonder bestaand opdrachtbestand", () => {
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", join(dir, "bestaat-niet.md"), "--lead", "lead-x"], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/opdrachtbestand bestaat niet/);
    expect(log("spawn.log")).toBe("");
  });

  test("weigert zonder naam, opdracht of lead, en bij een ongeldig model", () => {
    expect(draai(SPAWN, ["--opdracht", opdracht(), "--lead", "l"], basis()).fout).toMatch(/--naam/);
    expect(draai(SPAWN, ["--naam", "w1", "--lead", "l"], basis()).fout).toMatch(/--opdracht/);
    expect(draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht()], basis()).fout).toMatch(/lead/);
    expect(draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--model", "gpt"], basis()).fout).toMatch(/sonnet of opus/);
  });

  test("weigert een naam met spaties of shell-tekens", () => {
    const r = draai(SPAWN, ["--naam", "a; rm -rf", "--opdracht", opdracht(), "--lead", "l"], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/mag alleen/);
  });

  test("--droog toont wat er gebeurt en start niets", () => {
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead-x", "--model", "opus", "--droog"], basis());
    expect(r.code).toBe(0);
    expect(r.uit).toContain('window');
    expect(r.uit).toContain("claude -n w1 --model opus");
    expect(r.uit).toContain("Je lead is lead-x. Jij bent sessie w1.");
    expect(log("spawn.log")).toBe("");
    expect(log("tmux.log")).toBe("");
  });

  test("start, wacht op de prompt, typt de startzin letterlijk en geeft het pane-id", () => {
    writeFileSync(join(dir, "pane.txt"), "Claude Code\n  auto mode on (shift+tab)\n");
    writeFileSync(join(dir, "reageert"), "");
    const map = join(dir, "werkmap");
    mkdirSync(map);
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead-x", "--model", "sonnet", "--map", map], basis({ LAB_SPAWN_BEWIJS: "2", LAB_SPAWN_POLS: "1" }));
    expect(r.fout).toBe("");
    expect(r.code).toBe(0);
    expect(r.uit.trim()).toBe("%7");
    expect(log("spawn.log")).toContain("window");
    expect(log("spawn.log")).toContain("claude -n w1 --model sonnet");
    const t = log("tmux.log");
    expect(t).toContain("send-keys -t %7 -l Je lead is lead-x. Jij bent sessie w1. Lees");
    expect(t).toContain("SendMessage (to: lead-x).");
    expect(t).toContain("send-keys -t %7 Enter");
    // de opdracht staat niet in de aangeroepen claude-opdracht (geen prompt in de quotes)
    expect(log("spawn.log")).not.toContain("Je lead is");
  });

  test("LAB_LEAD_NAAM geldt als --lead ontbreekt", () => {
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--droog"], basis({ LAB_LEAD_NAAM: "uit-env" }));
    expect(r.uit).toContain("Je lead is uit-env.");
  });

  test("meldt het als de sessie niet klaar komt voor invoer en typt niets", () => {
    writeFileSync(join(dir, "pane.txt"), "Loading ...\n");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--map", dir], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet klaar voor invoer/);
    expect(log("tmux.log")).not.toContain("send-keys");
  });

  test("meldt het als er na de startzin geen tool-aanroep verschijnt", () => {
    writeFileSync(join(dir, "pane.txt"), "❯ \n");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--map", dir], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/geen tool-aanroep/);
    expect(log("tmux.log")).toContain("send-keys -t %7 Enter");
  });
});
