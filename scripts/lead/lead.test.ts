import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  git(dir, "init", "-q", "--bare", origin);
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
    expect(zonderId(a.uit)).toContain(`"${voor("agent")}"`);
    expect(a.uit).toContain("@agent_rol agent");
    expect(a.uit).toContain("@agent_naam w1");
    const s = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--sublead", "--droog"], basis());
    expect(zonderId(s.uit)).toContain(`"${voor("sublead")}"`);
    const v = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--vervolg", "lead/test-tak", "--map", repo, "--droog"], basis());
    expect(zonderId(v.uit)).toContain(`"${voor("vervolg")}"`);
    const m = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--model", "opus", "--droog"], basis());
    expect(zonderId(m.uit)).toContain(`${voor("agent")} --model opus"`);
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
  const basis = (extra: Record<string, string> = {}) => ({
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
    const zonder = codex(["--map", wt, "--droog"], { LAB_PEERS_SERVER: join(dir, "bestaat-niet.ts") });
    expect(zonder.fout).toMatch(/peers-MCP .* ontbreekt/);
    expect(zonder.uit).not.toContain("mcp_servers.peers");
  });

  test("sandbox: tmux start de werker met een permissieprofiel (netwerk aan, -a never); de gedeelde .git is niet als geheel schrijfbaar", () => {
    writeFileSync(join(dir, "pane.txt"), "Ask Codex\n• Ran ls\n");
    const r = codex(["--map", wt, "--droog"], { TMPDIR: join(dir, "sbtmp") });
    const gem = realpathSync(join(repo, ".git"));
    const eigen = realpathSync(join(gem, "worktrees", "eigen-worktree"));
    expect(r.uit).toContain(" -a never ");
    expect(r.uit).toContain(`-c 'default_permissions="lab-werker"'`);
    expect(r.uit).toContain(`-c 'permissions.lab-werker.network={enabled=true}'`);
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
    expect(regels.some((x) => x.endsWith("/.codex/auth.json=none"))).toBe(true);
  });

  test("sandbox: een pad met een quote of backslash weigert spawn (nooit een halve sandbox)", () => {
    const slecht = join(dir, "slecht'pad");
    mkdirSync(slecht);
    const r = draai(SPAWN, ["--naam", "cx1", "--opdracht", opdracht(), "--lead", "lead-x", "--vendor", "codex", "--map", wt, "--droog"], basis({ TMPDIR: slecht }));
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
    const r = codex(["--map", wt, "--droog"], { TMPDIR: join(dir, "sbtmp") });
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
      const p = Bun.spawn([codexBin, "exec", "--skip-git-repo-check", ...cArgs.flatMap((c) => ["-c", c]), "doe"], { cwd: wt, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CODEX_HOME: ch }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), 90_000); // echte-klok: een echte codex-run, geen testklok
      await p.exited;
      clearTimeout(timer);
    } finally {
      server.stop(true);
    }
    expect(uitvoer).toContain("COMMIT-OK");
    for (const x of ["HOOK-OK", "CONFIG-OK", "COMMONDIR-OK", "GITDIR-OK", "CFGWT-OK", "BUITEN-OK"]) expect(uitvoer).not.toContain(x);
    expect((uitvoer.match(/[Oo]peration not permitted/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(git(wt, "log", "--format=%s", "-1").stdout.toString().trim()).toBe("sandbox-test");
    expect(existsSync(join(gem, "hooks", "x"))).toBe(false);
  }, 120_000);

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
    // een project-config in de worktree die hem aanzet, telt ook (gemeten: -c wint daarvan in tmux, maar niet in T3)
    mkdirSync(join(wt, ".codex"));
    writeFileSync(join(wt, ".codex", "config.toml"), 'web_search = "live"\n');
    const proj = codex(["--map", wt, "--t3", "--droog"]);
    expect(proj.code).toBe(1);
    expect(proj.fout).toMatch(/\.codex\/config\.toml zet hem aan/);
    expect(codex(["--map", wt, "--droog"]).uit).toContain(UIT); // tmux: -c wint
    writeFileSync(join(wt, ".codex", "config.toml"), 'web_search = "disabled"\n');
    expect(codex(["--map", wt, "--t3", "--droog"]).code).toBe(0);
  });

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
  });

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
