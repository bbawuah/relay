import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const voor = (rol: string) => `env LAB_AGENT_NAAM=w1 LAB_AGENT_ROL=${rol} LAB_LEAD_NAAM=lead-x LAB_OPDRACHT=${o} claude -n w1`;
    const a = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--droog"], basis());
    expect(a.uit).toContain(`"${voor("agent")}"`);
    expect(a.uit).toContain("@agent_rol agent");
    expect(a.uit).toContain("@agent_naam w1");
    const s = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--sublead", "--droog"], basis());
    expect(s.uit).toContain(`"${voor("sublead")}"`);
    const v = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--vervolg", "lead/test-tak", "--map", repo, "--droog"], basis());
    expect(v.uit).toContain(`"${voor("vervolg")}"`);
    const m = draai(SPAWN, ["--naam", "w1", "--opdracht", o, "--lead", "lead-x", "--model", "opus", "--droog"], basis());
    expect(m.uit).toContain(`${voor("agent")} --model opus"`);
  });

  test("een opdrachtpad met spatie staat in het voorvoegsel tussen enkele quotes", () => {
    const spatie = join(dir, "met spatie.md");
    writeFileSync(spatie, "x");
    const r = draai(SPAWN, ["--naam", "w1", "--opdracht", spatie, "--lead", "l", "--droog"], basis());
    expect(r.uit).toContain(`LAB_OPDRACHT='${spatie}' claude -n w1`);
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
