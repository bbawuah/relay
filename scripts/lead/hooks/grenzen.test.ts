import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../../test-integriteit";

// Draait de hook met JSON op stdin. GRENZEN_HOOK kan naar een andere kopie wijzen (rood-op-basis).
const HOOK = process.env.GRENZEN_HOOK ?? join(import.meta.dir, "grenzen.sh");
// De oude hook (zoals die in ~/.claude stond) als orakel voor de eigenschapstest.
const OUD = join(import.meta.dir, "fixtures", "grenzen-oud.sh");

// Een kaal `git push` gaat naar de huidige tak, en de hook weigert dat op main. Zonder
// eigen cwd zou de uitkomst van deze tests afhangen van de tak waarop ze draaien (rood
// op main en in de zelftest-kopie van de poort, die op main staat): daarom krijgt elke
// aanroep zonder cwd een lege repo op een eigen tak mee.
const EIGEN_TAK = (() => {
  const map = mkdtempSync(join(tmpdir(), "grenzen-eigen-tak-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "test/eigen-tak", map], { env: schoneEnv() });
  return map;
})();
afterAll(() => rmSync(EIGEN_TAK, { recursive: true, force: true }));

function draai(invoer: unknown, hook = HOOK) {
  const env = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "" };
  const metCwd = typeof invoer === "object" && invoer !== null && !("cwd" in invoer) ? { cwd: EIGEN_TAK, ...invoer } : invoer;
  const p = Bun.spawnSync(["bash", hook], { stdin: new TextEncoder().encode(JSON.stringify(metCwd)), env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString() };
}
const bash = (command: string, hook = HOOK) => draai({ tool_name: "Bash", tool_input: { command } }, hook);

const WEIGER = [
  "./scripts/uitrollen.sh",
  "bash apps/x/scripts/uitrollen.sh",
  "cd a && uitrollen.sh",
  "bun run uitrollen",
  "echo $(./uitrollen.sh)",
  'echo "$(./uitrollen.sh)"',
  "echo `./uitrollen.sh`",
  "FOO=1 sudo ./apps/tmux/scripts/uitrollen.sh",
  'git commit -m "x" && ./uitrollen.sh',
  'echo "a\nb"\n./uitrollen.sh',
  // regressies uit de review van PR 151: de oude hook weigerde deze ook
  "nice bash -c 'cd x && ./uitrollen.sh'",
  "timeout 5 bash -c 'cd x && ./uitrollen.sh'",
  "sudo -u brian bash -c 'cd x && ./uitrollen.sh'",
  "find . -exec sh -c 'a && ./uitrollen.sh' \\;",
  "ssh host 'cd x && ./uitrollen.sh'",
  `python3 -c "import os; os.system('cd x && ./uitrollen.sh')"`,
  "bash -c -- 'cd x && ./uitrollen.sh'",
  `bash -c '"true"; ./uitrollen.sh; "true"'`,
  "bash -c 'cd x && ./uitrollen.sh'",
  'sh -c "a; uitrollen.sh"',
  "zsh -c 'a; ./scripts/uitrollen.sh'",
  "env FOO=1 bash -c 'cd x && ./uitrollen.sh'",
  "nohup sh -c 'sleep 1; ./uitrollen.sh' &",
  "( ./uitrollen.sh )",
  "bash -c 'cd x && pkill -f dev-mock'",
  "nice bash -c 'a && pkill -f x'",
  "timeout 5 bash -c 'a; killall node'",
  "sudo -u brian bash -c 'a && pkill -f x'",
  "find . -exec sh -c 'a && pkill -f x' \\;",
  "ssh host 'a && killall node'",
  "bash -c -- 'a; pkill -f x'",
  // omzeilingen uit de herreview: $'..' (\' is een escape) en # als commentaar
  `git commit -m $'a\\' -m ' ; ./uitrollen.sh #'`,
  `git commit -m $'a\\' -m ' ; pkill -f x #'`,
  "git commit -m x # -m '\n./uitrollen.sh\n# '",
  "gh pr create --title x # --body '\npkill -f x\n# '",
  // ${x:-'} paart de quote binnen de expansie (bash 5.3); een speciaal teken geeft het strenge gedrag
  `git commit -m "\${x:-'}" -m '}"; ./uitrollen.sh\n`,
  `git commit -m "\${x:-'}" -m '}"; pkill -f x\n`,
  'git commit -m "a\\" ; ./uitrollen.sh ; \\""',
  `git commit -m "it's" ; ./uitrollen.sh`,
  // here-doc die de quotes anders laat lezen
  "cat <<A >/dev/null\ngit commit -m '\nA\n./uitrollen.sh\ncat <<B >/dev/null\n'\nB",
  "cat <<A >/dev/null\ngh pr comment 1 --body '\nA\n./uitrollen.sh\ncat <<B >/dev/null\n'\nB",
  "cat <<A >/dev/null\ngit commit -m '\nA\npkill -f x\ncat <<B >/dev/null\n'\nB",
  "cat <<-A >/dev/null\ngit commit -m '\nA\n./uitrollen.sh\ncat <<-B >/dev/null\n'\nB",
  "git commit -m 'x' ; ./uitrollen.sh",
  `git commit -m 'a'"b" ; ./uitrollen.sh`,
  "git -C x commit -m '; ./uitrollen.sh'",
  "git commit --message='; ./uitrollen.sh'",
  "gh api x -f body='; ./uitrollen.sh'",
  'gh pr create --body "`./uitrollen.sh`"',
  // een bericht dat zelf een echte start bevat blijft geweigerd
  'git commit -m "$(./uitrollen.sh)"',
  'git commit -m "a" -m "b" && ./uitrollen.sh',
  'git commit -m "x"y; ./uitrollen.sh',
  // ongebalanceerde quote: streng
  'echo "x\n./uitrollen.sh',
  "pkill -f dev-mock",
  "cd x && killall node",
  "echo $(pkill -f x)",
  "cat ~/.config/klaarover/key",
  "grep x .env",
  'echo "ok"\ncat .env.local',
  // rauwe git push: force, verwijderen, naar main, poort overslaan (alleen via push.sh)
  "git push --force origin lead/x",
  "git push -f",
  "git push -uf origin lead/x",
  "git push --force-with-lease origin lead/x",
  "git push origin +lead/x",
  "git push --mirror",
  "git push origin --delete lead/x",
  "git push -d origin lead/x",
  "git push origin :lead/x",
  "git push origin main",
  "git push origin HEAD:main",
  "git push origin lead/x:refs/heads/main",
  "git push --all",
  "git -C ../x push --force",
  "git -c core.x=y push -f origin x",
  "cd x && git push -f",
  "bash -c 'git push -f origin x'",
  "nice git push --force",
  "ssh host 'git push origin main'",
  "POORT_OVERSLAAN=1 git push",
  "export POORT_OVERSLAAN=1; git push -u origin lead/x",
  "git push --no-verify",
  // afgekorte lange opties (git neemt een unieke prefix aan)
  "git push --forc origin lead/x",
  "git push --force-w origin lead/x",
  "git push --del origin lead/x",
  "git push --mir",
  "git push --no-veri",
  "git push --al",
  "git push origin HEAD:Main",
  "git push origin x:refs/heads/MASTER",
  // hooks of aliassen langs de grenzen
  "git -c core.hooksPath=/dev/null push",
  "git -c alias.p=push p --force",
  "git --config-env=core.hooksPath=X push",
  "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git push",
  "git config alias.p 'push --force'",
  "git config --global alias.p push",
  "git config core.hooksPath /dev/null",
  // schrijvende gh api
  "gh api -X PUT repos/o/r/pulls/1/merge",
  "gh api --method DELETE repos/o/r/git/refs/heads/x",
  "gh api --method=POST repos/o/r/issues",
  "gh api -XPATCH repos/o/r",
  "gh api repos/o/r/git/refs -f ref=refs/heads/x",
  // -f/-F/--field/--raw-field/--input zonder expliciete GET is een POST
  "gh api repos/o/r/pulls/1/merge -f merge_method=squash",
  "gh api repos/o/r/issues -F title=x",
  "gh api repos/o/r/issues --field title=x",
  "gh api repos/o/r/issues --raw-field=title=x",
  "gh api repos/o/r/pulls/1/merge --input body.json",
  "gh -R o/r api repos/o/r/issues -f title=x",
  "gh api -f merge_method=squash repos/o/r/pulls/1/merge",
  // graphql met een mutation of een query uit een bestand
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  "gh api graphql -F query=@q.graphql",
  "gh api graphql --input q.json",
  // een alias kan een merge verstoppen
  "gh alias set m 'pr merge'",
  "gh alias import aliassen.yml",
  "gh -R o/r alias set m x",
  // rauw ssh jump … oc (alleen via lab-lees.sh)
  "ssh jump oc get pods",
  "ssh jump 'oc get secrets -o yaml'",
  "ssh -o BatchMode=yes jump oc logs x",
  'ssh brian@jump "cd x; oc get pods"',
  "ssh -J jump host oc get pods",
  "/usr/bin/ssh -T jump /usr/local/bin/oc delete pod x",
  "echo x | ssh jump oc apply -f -",
];
const DOOR = [
  'git commit -m "regel 1\nuitrollen gaat via Brian"',
  'glab mr create --description "samenvatting\nuitrollen.sh draait Brian\n- ./scripts/uitrollen.sh"',
  "git commit -m 'a\nuitrollen gaat via Brian; en ook && uitrollen.sh'",
  'git commit -m "kill: pkill -f x\npkill -f y"',
  'git tag -a v1 -m "a\nuitrollen klaar"',
  'gh pr create --title "uitrollen" --body "x\nuitrollen.sh via Brian"',
  'gh issue create --title "t" --body "a\nuitrollen.sh"',
  'glab mr create --title "t" --description "a\nuitrollen"',
  'glab mr note 1 --message "a\nuitrollen.sh"',
  `git commit -m "a\nuitrollen gaat via Brian" -m 'b\nuitrollen.sh'`,
  "grep uitrollen.sh x",
  "git diff apps/x/scripts/uitrollen.sh",
  "cat apps/x/scripts/uitrollen.sh",
  "kill 123",
  "git push",
  "git push -u origin lead/x",
  "git push origin refs/heads/lead/x:refs/heads/lead/x",
  "git commit -m 'git push --force naar main is verboden'",
  "echo git push --force",
  "grep -n 'git push -f' README.md",
  "git log --oneline origin/main",
  "ssh jump ls brian/docs",
  "scripts/lead/push.sh",
  "scripts/lead/push.sh --verwijder lead/x",
  "scripts/lead/lab-lees.sh get pods -n x",
  "git push --dry-run origin lead/x",
  "git push --follow-tags origin lead/x",
  "git config user.name x",
  "gh api repos/o/r/pulls/1",
  "gh api -X GET repos/o/r/pulls",
  // lezen van /merge en /git/refs mag weer
  "gh api repos/o/r/pulls/1/merge",
  "gh api repos/o/r/git/refs/heads/x",
  "gh api -X GET repos/o/r/search/issues -f q=x",
  "gh api --method GET repos/o/r/pulls -F per_page=5",
  "gh api graphql -f query='query { viewer { login } }'",
  "gh alias list",
  "gh pr view 1 --repo o/r",
];

// Witte lijst: alleen bij deze commando's mag de nieuwe hook iets doorlaten wat de oude weigerde.
const WITTE_LIJST = /\b(git\s+(commit|tag)|gh\s+(pr\s+(create|edit|comment)|issue)|glab\s+mr\s+(create|update|note))\b/;
const CASES = (() => {
  try {
    return readFileSync(join(import.meta.dir, "fixtures", "cases.txt"), "utf8")
      .split("\n====\n")
      .map((x) => x.replace(/\n$/, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
})();

describe("grenzen.sh", () => {
  for (const c of WEIGER)
    test(`weigert ${JSON.stringify(c)}`, () => {
      const r = bash(c);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Geweigerd door grenzen.sh");
    });
  for (const c of DOOR)
    test(`laat door ${JSON.stringify(c)}`, () => {
      expect(bash(c).code).toBe(0);
    });
  test("eigenschap: nieuw laat alleen door wat oud ook doorliet, of wat in de witte lijst valt", () => {
    const alle = [...WEIGER, ...DOOR, ...CASES];
    expect(alle.length).toBeGreaterThan(40);
    const schendingen = alle.filter((c) => bash(c, OUD).code === 2 && bash(c).code !== 2 && !WITTE_LIJST.test(c));
    expect(schendingen).toEqual([]);
  }, 120_000);
  test("een rauwe push of ssh jump … oc verwijst naar het smalle script", () => {
    expect(bash("git push -f").stderr).toContain("scripts/lead/push.sh");
    expect(bash("git push origin --delete lead/x").stderr).toContain("push.sh --verwijder");
    expect(bash("git push origin main").stderr).toContain("via een PR");
    expect(bash("POORT_OVERSLAAN=1 git push").stderr).toContain("alleen Brian");
    expect(bash("ssh jump oc get pods").stderr).toContain("scripts/lead/lab-lees.sh");
  });
  test("Read van een sleutelbestand wordt geweigerd, .example mag", () => {
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/.config/klaarover/token" } }).code).toBe(2);
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/x/.env" } }).code).toBe(2);
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/x/.env.example" } }).code).toBe(0);
  });
  const rauw = (tekst: string) => {
    const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(tekst), env: schoneEnv(), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stderr: p.stderr.toString() };
  };
  test("ongeldige invoer faalt dicht (exit 2, één melding)", () => {
    for (const t of ["geen json", "", '{"tool_name": "Bash"']) {
      const r = rauw(t);
      expect(r.code).toBe(2);
      expect(r.stderr).toBe("Geweigerd door grenzen.sh: eigen fout (invoer is geen geldige JSON); faalt dicht. Meld het de lead of Brian.\n");
    }
  });
  test("invoer van de verkeerde vorm faalt dicht: tool_input als string of lijst, JSON als lijst", () => {
    for (const t of ["[1]", '{"tool_name": "Bash", "tool_input": "git push --force"}', '{"tool_name": "Read", "tool_input": ["x"]}']) {
      const r = rauw(t);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("eigen fout (invoer heeft de verkeerde vorm)");
    }
  });
  test("een kapotte python-stap faalt dicht (exit 2)", () => {
    const map = mkdtempSync(join(tmpdir(), "grenzen-kapot-"));
    try {
      const kapot = join(map, "grenzen.sh");
      writeFileSync(kapot, readFileSync(HOOK, "utf8").replace("import json, os, re, sys, datetime\n", "import json, os, re, sys, datetime\nraise RuntimeError('kapot')\n"));
      const r = draai({ tool_name: "Bash", tool_input: { command: "ls" } }, kapot);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("eigen fout (python-status 1); faalt dicht");
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });
  test("een commando van meer dan 300 kB gaat via stdin en wordt nog getoetst", () => {
    const lang = `echo ${"x".repeat(300_000)}; git push --force origin lead/x`;
    const r = bash(lang);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("force-push mag niet");
    expect(bash(`echo ${"x".repeat(300_000)}`).code).toBe(0);
  });
});

describe("grenzen.sh: merge.sh vanuit een subagent", () => {
  const met = (command: string, extra: { agent_id?: string; agent_type?: string }) => draai({ tool_name: "Bash", tool_input: { command }, ...extra });
  for (const c of ["scripts/lead/merge.sh 153", "/usr/local/lib/lab-lead/merge.sh 153 --droog", "bash ./merge.sh 1", "cd x && LAB_AGENT_ROL=lead ~/r/scripts/lead/merge.sh 1", "bash -c 'scripts/lead/merge.sh 1'"])
    test(`weigert ${JSON.stringify(c)} met agent_id of agent_type`, () => {
      for (const extra of [{ agent_id: "a123" }, { agent_type: "general-purpose" }]) {
        const r = met(c, extra);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("subagent of fork merget niet");
      }
      expect(bash(c).code).toBe(0); // de lead zelf (geen agent_id) mag
    });
  test("lezen van merge.sh mag ook voor een subagent", () => {
    for (const c of ["cat scripts/lead/merge.sh", "git diff scripts/lead/merge.sh", "grep -n x scripts/lead/merge.sh"]) expect(met(c, { agent_id: "a1" }).code).toBe(0);
  });
});

describe("grenzen.sh: rauwe merge zodra LAB_GRENS_MERGE=1", () => {
  const metMerge = (command: string) => {
    const env = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "1" };
    const invoer = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
    const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(invoer), env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stderr: p.stderr.toString() };
  };
  const PR_MERGE = ["pr", "merge"].join(" ");
  for (const c of [`gh ${PR_MERGE} 1`, `gh -R o/r ${PR_MERGE} 1`, `gh --repo o/r ${PR_MERGE} 1 --squash`, `gh --repo=o/r ${PR_MERGE} 1`, `gh "pr" 'merge' 1`, `gh pr -R o/r merge 1`, `/opt/homebrew/bin/gh -R o/r ${PR_MERGE}`])
    test(`weigert ${JSON.stringify(c)}`, () => {
      const r = metMerge(c);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("merge.sh");
    });
  test("lezen van een PR mag", () => {
    for (const c of ["gh pr view 1", "gh -R o/r pr checks 1", "gh api repos/o/r/pulls/1/merge"]) expect(metMerge(c).code).toBe(0);
  });
});

describe("grenzen.sh: push zonder doeltak op main", () => {
  const repo = (tak: string) => {
    const map = mkdtempSync(join(tmpdir(), "grenzen-repo-"));
    Bun.spawnSync(["git", "init", "-q", "-b", tak, map], { env: schoneEnv() });
    return map;
  };
  test("weigert `git push` en `git push origin HEAD` als de huidige tak main of master is", () => {
    for (const tak of ["main", "master"]) {
      const map = repo(tak);
      try {
        for (const c of ["git push", "git push origin", "git push origin HEAD", "git push -u origin +HEAD"]) {
          const r = draai({ tool_name: "Bash", tool_input: { command: c }, cwd: map });
          expect(r.code).toBe(2);
        }
        expect(draai({ tool_name: "Bash", tool_input: { command: `cd ${map} && git push` }, cwd: "/" }).code).toBe(2);
        expect(draai({ tool_name: "Bash", tool_input: { command: `git -C ${map} push` }, cwd: "/" }).code).toBe(2);
        expect(draai({ tool_name: "Bash", tool_input: { command: "git push origin lead/x" }, cwd: map }).code).toBe(0);
      } finally {
        rmSync(map, { recursive: true, force: true });
      }
    }
  });
  test("laat `git push` door op een eigen tak", () => {
    const map = repo("lead/x");
    try {
      expect(draai({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: map }).code).toBe(0);
      expect(draai({ tool_name: "Bash", tool_input: { command: "git push origin HEAD" }, cwd: map }).code).toBe(0);
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });
});

describe("grenzen.sh: here-doc-berichten", () => {
  const PR = "gh pr create --title \"lead: x\" --body \"$(cat <<'EOF'\n## Samenvatting\n\ngit push --force en ./uitrollen.sh staan alleen in de tekst; pkill -f x\nEOF\n)\"";
  test("de here-doc-tekst van gh pr create en git commit wordt leeggemaakt", () => {
    expect(bash(PR).code).toBe(0);
    expect(bash(`git commit -q -m "$(cat <<'EOF'\nlead: x\n\nssh jump oc get pods ging via lab-lees.sh\nEOF\n)"`).code).toBe(0);
    expect(bash(`git commit -m "$(cat <<EOF\nlead: x, git push -f is verboden\nEOF\n)"`).code).toBe(0);
    expect(bash(`gh pr comment 1 --body "$(cat <<'EOF'\nuitrollen.sh via Brian\nEOF\n)"`).code).toBe(0);
  });
  test("ook met een kop `cd x && …` of `git -C x commit`", () => {
    expect(bash(`cd /tmp/wt && ${PR}`).code).toBe(0);
    expect(bash(`git -C /tmp/wt commit -m "$(cat <<'EOF'\nlead: x\n\ngit push --force staat alleen in de tekst\nEOF\n)"`).code).toBe(0);
    expect(bash(`cd /tmp/wt && git -C sub commit -m "$(cat <<'EOF'\nuitrollen.sh via Brian\nEOF\n)"`).code).toBe(0);
    // twee koppen of iets anders dan cd ervoor blijft streng
    expect(bash(`./uitrollen.sh && ${PR}`).code).toBe(2);
    expect(bash(`cd a && cd b && git commit -m "$(cat <<'EOF'\n./uitrollen.sh\nEOF\n)"`).code).toBe(2);
  });
  test("wat na de here-doc komt, wordt nog getoetst", () => {
    expect(bash(`${PR} && ./uitrollen.sh`).code).toBe(2);
    expect(bash(`${PR}; git push --force`).code).toBe(2);
  });
  test("streng bij twijfel", () => {
    // ongequote marker met $( in de tekst: wordt echt uitgevoerd
    expect(bash(`git commit -m "$(cat <<EOF\n$(./uitrollen.sh)\nEOF\n)"`).code).toBe(2);
    // de eindmarkering staat al eerder in de tekst: bash stopt daar, de rest is een commando
    expect(bash(`gh pr create --body "$(cat <<'EOF'\na\nEOF\n./uitrollen.sh\nEOF\n)"`).code).toBe(2);
    // iets onduidelijks vóór de here-doc
    expect(bash(`echo $(./uitrollen.sh) | gh pr create --body "$(cat <<'EOF'\na\nEOF\n)"`).code).toBe(2);
    expect(bash(`./uitrollen.sh; gh pr create --body "$(cat <<'EOF'\na\nEOF\n)"`).code).toBe(2);
  });
});

describe("grenzen.sh: grootte van vaultnotities", () => {
  const HOME = mkdtempSync(join(tmpdir(), "grenzen-vault-"));
  const VAULT = join(HOME, "vault-b-status");
  mkdirSync(join(VAULT, "archief"), { recursive: true });
  mkdirSync(join(VAULT, "emb-gemma"), { recursive: true });
  mkdirSync(join(VAULT, "spoor"), { recursive: true });
  afterAll(() => rmSync(HOME, { recursive: true, force: true }));
  const GROOT = "x".repeat(50 * 1024);
  const KLEIN = "y".repeat(1024);
  const hook = (tool: string, tool_input: unknown, extra: Record<string, string> = {}) => {
    const env = { ...schoneEnv(), HOME, LAB_GRENS_MERGE: "", ...extra };
    const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ tool_name: tool, tool_input, cwd: EIGEN_TAK })), env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stderr: p.stderr.toString() };
  };
  const schrijf = (naam: string, tekst: string) => writeFileSync(join(VAULT, naam), tekst);

  test("een nieuw te groot bestand wordt geweigerd, met grootte, limiet en oplossing", () => {
    const r = hook("Write", { file_path: join(VAULT, "PLAN-nieuw.md"), content: GROOT });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("50 KB");
    expect(r.stderr).toContain("40 KB");
    expect(r.stderr).toContain("splits per spoor");
    expect(r.stderr).toContain("archief/");
  });
  test("een klein bestand en een bestand precies op de limiet mogen", () => {
    expect(hook("Write", { file_path: join(VAULT, "klein.md"), content: KLEIN }).code).toBe(0);
    expect(hook("Write", { file_path: join(VAULT, "grens.md"), content: "z".repeat(40960) }).code).toBe(0);
    expect(hook("Write", { file_path: join(VAULT, "grens.md"), content: "z".repeat(40961) }).code).toBe(2);
  });
  test("bytes tellen, geen tekens", () => {
    expect(hook("Write", { file_path: join(VAULT, "u.md"), content: "é".repeat(25000) }).code).toBe(2);
  });
  test("een Edit die een groot bestand laat groeien wordt geweigerd; krimpen of gelijk blijven mag", () => {
    schrijf("groot.md", `kop\n${GROOT}`);
    expect(hook("Edit", { file_path: join(VAULT, "groot.md"), old_string: "kop", new_string: "een langere kop" }).code).toBe(2);
    expect(hook("Edit", { file_path: join(VAULT, "groot.md"), old_string: "kop", new_string: "kop2" }).code).toBe(2);
    expect(hook("Edit", { file_path: join(VAULT, "groot.md"), old_string: "kop", new_string: "kop" }).code).toBe(0);
    expect(hook("Edit", { file_path: join(VAULT, "groot.md"), old_string: "kop\n", new_string: "" }).code).toBe(0);
    expect(hook("Write", { file_path: join(VAULT, "groot.md"), content: KLEIN }).code).toBe(0);
  });
  test("replace_all telt elk voorkomen; MultiEdit telt alle edits", () => {
    schrijf("midden.md", "a ".repeat(15000));
    expect(hook("Edit", { file_path: join(VAULT, "midden.md"), old_string: "a", new_string: "aa", replace_all: true }).code).toBe(2);
    expect(hook("Edit", { file_path: join(VAULT, "midden.md"), old_string: "a", new_string: "aa" }).code).toBe(0);
    expect(hook("MultiEdit", { file_path: join(VAULT, "midden.md"), edits: [{ old_string: "a a", new_string: "a" }, { old_string: "a", new_string: "aaaaaaaa", replace_all: true }] }).code).toBe(2);
  });
  test("een Edit op een ontbrekend bestand is geen eigen fout: alleen de nieuwe tekst telt", () => {
    expect(hook("Edit", { file_path: join(VAULT, "bestaat-niet.md"), old_string: "a", new_string: KLEIN }).code).toBe(0);
    expect(hook("Edit", { file_path: join(VAULT, "bestaat-niet.md"), old_string: "a", new_string: GROOT }).code).toBe(2);
  });
  test("uitzonderingen: lead.md in de root, archief/ en emb-gemma/", () => {
    expect(hook("Write", { file_path: join(VAULT, "lead.md"), content: GROOT }).code).toBe(0);
    expect(hook("Write", { file_path: join(VAULT, "archief", "oud.md"), content: GROOT }).code).toBe(0);
    expect(hook("Write", { file_path: join(VAULT, "emb-gemma", "x.md"), content: GROOT }).code).toBe(0);
    // lead.md in een submap is geen uitzondering
    expect(hook("Write", { file_path: join(VAULT, "spoor", "lead.md"), content: GROOT }).code).toBe(2);
    // een pad met .. dat uit archief/ naar de root loopt telt als de root
    expect(hook("Write", { file_path: join(VAULT, "archief", "..", "groot2.md"), content: GROOT }).code).toBe(2);
  });
  test("een .md buiten de vault en een niet-.md in de vault mogen", () => {
    expect(hook("Write", { file_path: join(HOME, "elders", "plan.md"), content: GROOT }).code).toBe(0);
    expect(hook("Write", { file_path: join(HOME, "vault-b-status-kopie", "plan.md"), content: GROOT }).code).toBe(0);
    expect(hook("Write", { file_path: join(VAULT, "data.json"), content: GROOT }).code).toBe(0);
  });
  test("LAB_VAULT_MAX_KB verlegt de limiet", () => {
    expect(hook("Write", { file_path: join(VAULT, "a.md"), content: GROOT }, { LAB_VAULT_MAX_KB: "100" }).code).toBe(0);
    expect(hook("Write", { file_path: join(VAULT, "a.md"), content: KLEIN }, { LAB_VAULT_MAX_KB: "0.5" }).code).toBe(2);
  });
});
