import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  // Zonder rol: de hoofdcheckout-regel geldt alleen voor een sessie met LAB_AGENT_ROL (ook als deze test in zo'n sessie draait).
  const env = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "", LAB_AGENT_ROL: "" };
  const metCwd = typeof invoer === "object" && invoer !== null && !("cwd" in invoer) ? { cwd: EIGEN_TAK, ...invoer } : invoer;
  const p = Bun.spawnSync(["bash", hook], { stdin: new TextEncoder().encode(JSON.stringify(metCwd)), env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString() };
}
const bash = (command: string, hook = HOOK) => draai({ tool_name: "Bash", tool_input: { command } }, hook);
const bashAlsRol = (command: string, rol: string, pane = "%eigen") => {
  const env = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "", LAB_AGENT_ROL: rol, TMUX_PANE: pane };
  const invoer = { tool_name: "Bash", tool_input: { command }, cwd: EIGEN_TAK };
  const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify(invoer)), env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString() };
};
// Elke hook-aanroep is een eigen bash-proces (met jq en git erin): ~0,1 s onbelast, een veelvoud onder
// machinebelasting. Voor de vaste lijsten WEIGER/DOOR/CASES (puur commandotekst, vaste cwd EIGEN_TAK, geen
// bestanden) hangt de uitkomst alleen van (hook, commando) af: de eigenschapstest hergebruikt wat de losse
// weiger-/doortests al draaiden in plaats van dezelfde aanroep nog eens te starten.
const UITKOMST = new Map<string, ReturnType<typeof draai>>();
const bashVast = (command: string, hook = HOOK) => {
  const sleutel = `${hook}\0${command}`;
  let r = UITKOMST.get(sleutel);
  if (!r) UITKOMST.set(sleutel, (r = bash(command, hook)));
  return r;
};
// Tests die meerdere hook-processen achter elkaar starten krijgen een ruime tijdgrens: het proces is
// het onderwerp van de test, en de standaard van 5 s past bij werk zonder subproces.
// echte-klok: tijdgrens voor subprocessen, geen wachttijd; onder belasting duurt een spawn seconden
const RUIM = 60_000;

describe("grenzen.sh: lead-proef blijft in de eigen pane en uit de Claude-sockets", () => {
  test("weigert tmux send-keys en paste-buffer naar een andere pane of sessie", () => {
    for (const command of ["tmux send-keys -t %ander -l hallo", "tmux paste-buffer --target=sessie:0", "tmux paste-buffer -t%ander"])
      expect(bashAlsRol(command, "lead-proef").code).toBe(2);
  });

  test("laat de eigen pane en een tmux-opdracht zonder doel door", () => {
    expect(bashAlsRol("tmux send-keys -t %eigen -l hallo", "lead-proef").code).toBe(0);
    expect(bashAlsRol("tmux paste-buffer", "lead-proef").code).toBe(0);
  });

  test("weigert redirects naar /tmp/cc-socks, maar niet lezen", () => {
    for (const command of ["printf x > /tmp/cc-socks/123.sock", "echo x >> '/tmp/cc-socks/456.sock'"])
      expect(bashAlsRol(command, "lead-proef").code).toBe(2);
    expect(bashAlsRol("ls /tmp/cc-socks", "lead-proef").code).toBe(0);
  });
});

describe("grenzen.sh: lead-proef merge via het gecontroleerde pad, niet via push of gh", () => {
  test("laat merge.sh door, ook zonder --droog", () => {
    expect(bashAlsRol("scripts/lead/merge.sh 700", "lead-proef").code).toBe(0);
    expect(bashAlsRol("scripts/lead/merge.sh --droog 700", "lead-proef").code).toBe(0);
  });

  test("weigert push-werker, gh pr merge en een roltoewijzing", () => {
    for (const command of [
      "LAB_AGENT_ROL=lead scripts/lead/merge.sh 700",
      "scripts/lead/push-werker.sh werk/tak",
      "gh pr merge 700",
      "LAB_AGENT_ROL=lead true",
    ])
      expect(bashAlsRol(command, "lead-proef").code).toBe(2);
  });

  test("laat leesacties op merge- en pushwerkercode door", () => {
    expect(bashAlsRol("cat scripts/lead/merge.sh", "lead-proef").code).toBe(0);
    expect(bashAlsRol("git log -- scripts/lead/push-werker.sh", "lead-proef").code).toBe(0);
  });

  test("weigert roltoewijzing en git -c ook als git verder alleen leest", () => {
    for (const command of [
      "LAB_AGENT_ROL=lead git status",
      "git -c diff.external='bash scripts/lead/merge.sh 700' diff",
      "git -c core.fsmonitor='bash scripts/lead/merge.sh 700' status",
      "git -c core.pager='bash scripts/lead/merge.sh 700' -p log",
      "git -c core.sshCommand='bash scripts/lead/push-werker.sh x' fetch",
    ])
      expect(bashAlsRol(command, "lead-proef").code).toBe(2);
  });
});

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
      const r = bashVast(c);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Geweigerd door grenzen.sh");
    });
  for (const c of DOOR)
    test(`laat door ${JSON.stringify(c)}`, () => {
      expect(bashVast(c).code).toBe(0);
    });
  test("eigenschap: nieuw laat alleen door wat oud ook doorliet, of wat in de witte lijst valt", () => {
    const alle = [...WEIGER, ...DOOR, ...CASES];
    expect(alle.length).toBeGreaterThan(40);
    const schendingen = alle.filter((c) => bashVast(c, OUD).code === 2 && bashVast(c).code !== 2 && !WITTE_LIJST.test(c));
    expect(schendingen).toEqual([]);
  }, 120_000);
  test("een rauwe push of ssh jump … oc verwijst naar het smalle script", () => {
    expect(bash("git push -f").stderr).toContain("scripts/lead/push.sh");
    expect(bash("git push origin --delete lead/x").stderr).toContain("push.sh --verwijder");
    expect(bash("git push origin main").stderr).toContain("via een PR");
    expect(bash("POORT_OVERSLAAN=1 git push").stderr).toContain("alleen Brian");
    expect(bash("ssh jump oc get pods").stderr).toContain("scripts/lead/lab-lees.sh");
  }, RUIM);
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
  }, RUIM);
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
  // De drie repo's worden één keer gemaakt (het lezen van de huidige tak verandert niets aan ze), niet per test.
  const MAPPEN = new Map<string, string>();
  beforeAll(() => {
    for (const tak of ["main", "master", "lead/x"]) {
      const map = mkdtempSync(join(tmpdir(), "grenzen-repo-"));
      Bun.spawnSync(["git", "init", "-q", "-b", tak, map], { env: schoneEnv() });
      MAPPEN.set(tak, map);
    }
  });
  afterAll(() => {
    for (const map of MAPPEN.values()) rmSync(map, { recursive: true, force: true });
  });
  const push = (command: string, cwd: string) => draai({ tool_name: "Bash", tool_input: { command }, cwd }).code;
  test("weigert `git push` en `git push origin HEAD` als de huidige tak main of master is", () => {
    for (const tak of ["main", "master"]) {
      const map = MAPPEN.get(tak) as string;
      for (const c of ["git push", "git push origin", "git push origin HEAD", "git push -u origin +HEAD"]) expect(push(c, map)).toBe(2);
      expect(push(`cd ${map} && git push`, "/")).toBe(2);
      expect(push(`git -C ${map} push`, "/")).toBe(2);
      expect(push("git push origin lead/x", map)).toBe(0);
    }
  }, RUIM);
  test("laat `git push` door op een eigen tak", () => {
    const map = MAPPEN.get("lead/x") as string;
    expect(push("git push", map)).toBe(0);
    expect(push("git push origin HEAD", map)).toBe(0);
  }, RUIM);
});

describe("grenzen.sh: here-doc-berichten", () => {
  const PR = "gh pr create --title \"lead: x\" --body \"$(cat <<'EOF'\n## Samenvatting\n\ngit push --force en ./uitrollen.sh staan alleen in de tekst; pkill -f x\nEOF\n)\"";
  test("de here-doc-tekst van gh pr create en git commit wordt leeggemaakt", () => {
    expect(bash(PR).code).toBe(0);
    expect(bash(`git commit -q -m "$(cat <<'EOF'\nlead: x\n\nssh jump oc get pods ging via lab-lees.sh\nEOF\n)"`).code).toBe(0);
    expect(bash(`git commit -m "$(cat <<EOF\nlead: x, git push -f is verboden\nEOF\n)"`).code).toBe(0);
    expect(bash(`gh pr comment 1 --body "$(cat <<'EOF'\nuitrollen.sh via Brian\nEOF\n)"`).code).toBe(0);
  }, RUIM);
  test("ook met een kop `cd x && …` of `git -C x commit`", () => {
    expect(bash(`cd /tmp/wt && ${PR}`).code).toBe(0);
    expect(bash(`git -C /tmp/wt commit -m "$(cat <<'EOF'\nlead: x\n\ngit push --force staat alleen in de tekst\nEOF\n)"`).code).toBe(0);
    expect(bash(`cd /tmp/wt && git -C sub commit -m "$(cat <<'EOF'\nuitrollen.sh via Brian\nEOF\n)"`).code).toBe(0);
    // twee koppen of iets anders dan cd ervoor blijft streng
    expect(bash(`./uitrollen.sh && ${PR}`).code).toBe(2);
    expect(bash(`cd a && cd b && git commit -m "$(cat <<'EOF'\n./uitrollen.sh\nEOF\n)"`).code).toBe(2);
  }, RUIM);
  test("wat na de here-doc komt, wordt nog getoetst", () => {
    expect(bash(`${PR} && ./uitrollen.sh`).code).toBe(2);
    expect(bash(`${PR}; git push --force`).code).toBe(2);
  }, RUIM);
  test("streng bij twijfel", () => {
    // ongequote marker met $( in de tekst: wordt echt uitgevoerd
    expect(bash(`git commit -m "$(cat <<EOF\n$(./uitrollen.sh)\nEOF\n)"`).code).toBe(2);
    // de eindmarkering staat al eerder in de tekst: bash stopt daar, de rest is een commando
    expect(bash(`gh pr create --body "$(cat <<'EOF'\na\nEOF\n./uitrollen.sh\nEOF\n)"`).code).toBe(2);
    // iets onduidelijks vóór de here-doc
    expect(bash(`echo $(./uitrollen.sh) | gh pr create --body "$(cat <<'EOF'\na\nEOF\n)"`).code).toBe(2);
    expect(bash(`./uitrollen.sh; gh pr create --body "$(cat <<'EOF'\na\nEOF\n)"`).code).toBe(2);
  }, RUIM);
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

describe("grenzen.sh: recursief zoeken sluit sleutelbestanden uit", () => {
  // Nepbestanden in een tijdelijke map; er wordt nooit een echt sleutelbestand gelezen.
  const MAP = mkdtempSync(join(tmpdir(), "grenzen-zoek-"));
  writeFileSync(join(MAP, "één-bestand.txt"), "foo\n");
  writeFileSync(join(MAP, "config.properties"), "nep\n");
  afterAll(() => rmSync(MAP, { recursive: true, force: true }));
  const zoek = (command: string) => draai({ tool_name: "Bash", tool_input: { command }, cwd: MAP });

  const GREP_UIT = "--exclude=config.properties --exclude=config.json --exclude='.env*'";
  const RG_UIT = "--glob '!config.properties' --glob '!config.json' --glob '!.env*'";
  const GIT_UIT = "':!*config.properties' ':!*config.json' ':!*.env*'";

  const WEIGER_ZOEK = [
    "grep -rn foo .",
    "grep -R foo repo/",
    "grep --recursive foo .",
    "grep -nri foo .",
    "egrep -r foo .",
    "rg foo",
    "rg foo repo/",
    "git grep foo",
    "git -C repo grep -n foo",
    "rg --glob '!config.properties' foo .",
    "rg -g '!config.properties' foo .",
    "grep -rn --exclude=config.properties foo .",
    "grep -rn --exclude=config.properties --exclude=config.json foo .",
    "git grep foo -- . ':!*config.properties'",
    // zsh expandeert een ongequote .env*, dus de uitsluiting telt niet
    "grep -rn --exclude=config.properties --exclude=config.json --exclude=.env* foo .",
    // een uitsluiting op de verkeerde naam
    "rg --glob '!config.properties' --glob '!config.json' --glob '!.env.example' foo .",
    // in een omhulsel of na een wrapper
    'bash -c "rg foo ."',
    "timeout 5 rg foo .",
    "find . -type f -exec grep -r foo {} +",
    "cd repo && rg foo",
    "cat x | rg foo .",
    // het enige pad is zelf een sleutelbestand, of er zijn meer paden
    "rg foo config.properties",
    "grep -r foo config.properties",
    "rg foo één-bestand.txt andere.txt",
    "rg -e foo -e bar",
    // regressies van de tekstfix: echte aanroepen naast of na tekst blijven geweigerd
    "echo a | xargs grep -r x",
    "grep -r x .",
    'echo "klaar" && grep -rn foo .',
    'echo "klaar"; rg foo .',
    "echo klaar | grep -r foo repo/",
    'bash -c "echo x; grep -r foo ."',
    "bash -c 'echo x | rg foo .'",
    'echo "$(grep -r foo .)"',
    'echo "`rg foo .`"',
    'git commit -m "$(rg foo .)"',
    "cat <<'EOF'\ntekst\nEOF\ngrep -r foo .",
    "bash <<'EOF'\ngrep -r foo .\nEOF",
    "cat <<EOF\n$(grep -r foo .)\nEOF",
  ];
  const DOOR_ZOEK = [
    `grep -rn ${GREP_UIT} foo .`,
    `grep -R ${GREP_UIT} foo repo/`,
    `rg ${RG_UIT} foo .`,
    "rg -g '!config.properties' -g '!config.json' -g '!.env*' foo .",
    "rg --glob='!**/config.properties' --glob='!*config.json' --glob '!.env.*' foo",
    `git grep foo -- . ${GIT_UIT}`,
    "git grep -n foo -- ':(exclude)config.properties' ':(exclude,glob)**/config.json' ':^.env*'",
    "grep -rn --exclude config.properties --exclude config.json --exclude '.env*' foo .",
    // één expliciet bestand, geen recursie
    "grep foo één-bestand.txt",
    "grep -n foo één-bestand.txt andere.txt",
    "rg foo één-bestand.txt",
    "grep -r foo één-bestand.txt",
    // stdin of geen zoekopdracht
    "git log | rg foo",
    "git diff | grep -n foo",
    "ls | grep foo",
    "rg --version",
    "rg --files",
    "which rg",
    "echo rg foo",
    "man grep",
    "ls -la && git status",
    "bun test scripts/lead/hooks/grenzen.test.ts",
    "git log --grep=foo",
    // tekst met een zoekwoord is geen zoekopdracht (vals alarm 19 okt)
    `echo "- 19 okt: Vals alarm grenzen.sh: heredoc-tekst 'grep/rg)' telt als zoekcommando → fix nodig" >> ~/x.md`,
    `echo "- 19 okt; Vals alarm: grep -r x . | rg y (tekst)" >> ~/x.md`,
    `printf '%s\\n' "grep -r foo . && rg foo" > f.txt`,
    `git commit -m "grenzen: grep -r en rg; weiger | niet"`,
    `git commit -m "fix: zoek met grep -r x ." -m "rg foo"`,
    `gh pr create --title "x" --body "Zoeken (grep/rg, ook via subagents) sluit uit; rg foo ."`,
    "cat > f.md <<'EOF'\n- Zoeken (grep/rg, ook via subagents) sluit sleutelbestanden uit\n- grep -r foo . en rg foo\nEOF",
    "cat > f.md <<EOF\n- Zoeken (grep/rg) sluit uit\nEOF",
    "cat >> f.md <<-'EOF'\n\tgrep -rn foo .\n\tEOF",
    "cat <<'EOF' | tee f.md\nrg foo .\nEOF",
    "cat > f.md <<'EOF'\n- grep -r foo .\nEOF\nls",
    'echo "x" > f; ls',
  ];
  for (const c of WEIGER_ZOEK)
    test(`weigert ${JSON.stringify(c)}`, () => {
      const r = zoek(c);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Geweigerd door grenzen.sh: recursief zoeken moet sleutelbestanden uitsluiten");
    });
  for (const c of DOOR_ZOEK)
    test(`laat door ${JSON.stringify(c)}`, () => {
      expect(zoek(c).code).toBe(0);
    });
  test("de melding noemt het juiste commando en wat ontbreekt", () => {
    const rg = zoek("rg --glob '!config.properties' foo .").stderr;
    expect(rg).toContain("ontbreekt: config.json, .env*");
    expect(rg).toContain("rg --glob '!config.properties' --glob '!config.json' --glob '!.env*' <patroon> <pad>");
    expect(zoek("grep -rn foo .").stderr).toContain("grep -rn --exclude=config.properties --exclude=config.json --exclude='.env*'");
    expect(zoek("git grep foo").stderr).toContain("':!*config.properties'");
    expect(zoek("grep -rn --exclude=.env* foo .").stderr).toContain("tussen quotes");
  });
});

describe("grenzen.sh: kustomize-render van sleutelbestanden", () => {
  // Nep-kustomization-mappen: alleen de kustomization.yaml staat er, nooit een echt sleutelbestand.
  const K = realpathSync(mkdtempSync(join(tmpdir(), "grenzen-kustomize-")));
  afterAll(() => rmSync(K, { recursive: true, force: true }));
  const maak = (naam: string, yaml: string) => {
    mkdirSync(join(K, naam), { recursive: true });
    writeFileSync(join(K, naam, "kustomization.yaml"), yaml);
    return join(K, naam);
  };
  const MET = maak("met", "configMapGenerator:\n  - name: app\n    files:\n      - config.properties\n");
  const MET_JSON = maak("met-json", "configMapGenerator:\n- name: a\n  files: [x=config.json]\n");
  const MET_ENV = maak("met-env", "secretGenerator:\n- name: a\n  envs:\n  - .env.prod\n");
  const ZONDER = maak("zonder", "resources:\n  - deployment.yaml\nconfigMapGenerator:\n  - name: a\n    literals:\n      - A=1\n");
  const GECOMMENTARIEERD = maak("commentaar", "resources:\n  - deployment.yaml\n# files:\n#   - config.properties\n");
  const BASIS = maak("basis", "configMapGenerator:\n  - name: app\n    files:\n      - ./conf/config.properties\n");
  const OVERLAY = maak("overlay", "resources:\n  - ../basis\n");
  const OVERLAY_BASES = maak("overlay-bases", "bases: [../basis]\n");
  const OVERLAY_ZONDER = maak("overlay-zonder", "resources:\n  - ../zonder\n  - https://example.com/x//base?ref=v1\n");
  const KRING = maak("kring", "resources:\n  - ../kring\n");

  const WEIGER_K = [
    `kustomize build ${MET}`,
    `kustomize build --load-restrictor LoadRestrictionsNone ${MET}`,
    `kustomize build ${MET_JSON}`,
    `kustomize build ${MET_ENV}`,
    `oc kustomize ${MET}`,
    `kubectl kustomize ${MET}`,
    `kubectl -n x kustomize ${MET}`,
    `kubectl apply -k ${MET} --dry-run=client -o yaml`,
    `oc apply --dry-run=server -k ${MET}`,
    `kubectl apply --kustomize=${MET} --dry-run=client`,
    `kubectl diff -k ${MET}`,
    `oc diff --kustomize=${MET}`,
    `kustomize build ${OVERLAY}`,
    `kustomize build ${OVERLAY_BASES}`,
    `cd ${K} && kustomize build met`,
    `kustomize build ${MET} | grep x`,
    `echo klaar && kustomize build ${MET}`,
    `ls; kustomize build ${MET}`,
    `bash -c 'kustomize build ${MET}'`,
    `bash -c "cd ${K} && oc kustomize overlay"`,
    `sudo -u x bash -c 'kubectl kustomize ${MET} | head'`,
    `timeout 5 kustomize build ${MET}`,
    `ssh host 'kustomize build ${MET}'`,
    // doel niet te bepalen: dicht
    "kustomize build",
    `kustomize build ${join(K, "bestaat-niet")}`,
    "kustomize build $DIR",
    "oc kustomize `pwd`",
    "kubectl apply -k --dry-run=client",
    "kustomize build https://github.com/x/y//base",
  ];
  for (const c of WEIGER_K)
    test(`kustomize: weigert ${JSON.stringify(c)}`, () => {
      const r = bash(c);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("git diff");
    });

  const DOOR_K = [
    `kustomize build ${ZONDER}`,
    `kustomize build ${GECOMMENTARIEERD}`,
    `oc kustomize ${ZONDER}`,
    `kubectl apply -k ${MET}`, // geen --dry-run: niet gedekt (staat in de kop van het blok)
    `kubectl apply -f x.yaml --dry-run=client`,
    `kustomize build ${OVERLAY_ZONDER}`,
    `kustomize build ${KRING}`,
    `cd ${K} && kustomize build zonder`,
    "kustomize version",
    "kustomize --help",
    "kustomize edit set image a=b",
    "kubectl get configmap kustomize -n x",
    // tekst is geen commando
    `echo "kustomize build ${MET}"`,
    `git commit -m "kustomize build ${MET} weigeren"`,
    `gh pr create --title "kustomize build ${MET}" --body "oc kustomize ${MET}"`,
    `cat <<'EINDE' > notitie.md\nkustomize build ${MET}\nEINDE`,
    `grep -n "kustomize build" notitie.md`,
  ];
  for (const c of DOOR_K)
    test(`kustomize: laat door ${JSON.stringify(c)}`, () => {
      expect(bash(c).code).toBe(0);
    });

  test("het woord in een commit-bericht met heredoc geeft geen vals alarm", () => {
    const c = `git commit -m "$(cat <<'EINDE'\nlead: kustomize build ${MET} en oc kustomize ${MET}\nEINDE\n)"`;
    expect(bash(c).code).toBe(0);
  });
  test("een relatieve map volgt de cwd uit de invoer", () => {
    expect(draai({ tool_name: "Bash", tool_input: { command: "kustomize build met" }, cwd: K }).code).toBe(2);
    expect(draai({ tool_name: "Bash", tool_input: { command: "kustomize build zonder" }, cwd: K }).code).toBe(0);
  });
  test("de melding noemt het doel, de kustomization-map en het alternatief", () => {
    const m = bash(`kustomize build ${OVERLAY}`).stderr;
    expect(m).toContain(OVERLAY);
    expect(m).toContain(BASIS);
    expect(m).toContain("CI-poort");
  });
});

describe("grenzen.sh: geen schrijvende commando's in de hoofdcheckout", () => {
  // Nep-repo's in een tijdelijke map: een hoofdcheckout, een linked worktree en een aparte clone.
  const BASIS = mkdtempSync(join(tmpdir(), "grenzen-hoofd-"));
  const HOOFD = join(BASIS, "hoofd");
  const WORKTREE = join(BASIS, "eigen-worktree");
  const CLONE = join(BASIS, "eigen-clone");
  const git = (cwd: string, ...args: string[]) => {
    const env = { ...schoneEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  };
  mkdirSync(HOOFD, { recursive: true });
  git(HOOFD, "init", "-q", "-b", "main");
  mkdirSync(join(HOOFD, "sub"));
  writeFileSync(join(HOOFD, "sub", "b.txt"), "b\n");
  writeFileSync(join(HOOFD, "a.txt"), "a\n");
  git(HOOFD, "add", ".");
  git(HOOFD, "commit", "-q", "-m", "init");
  git(HOOFD, "worktree", "add", "-q", "-b", "eigen", WORKTREE);
  git(BASIS, "clone", "-q", HOOFD, CLONE);
  afterAll(() => rmSync(BASIS, { recursive: true, force: true }));

  // extra: subagent-velden; cwd: de werkmap uit de hook-invoer; rol: LAB_AGENT_ROL (null = niet gezet)
  const run = (command: string, cwd: string, extra: Record<string, unknown> = {}, rol: string | null = "agent") => {
    const env = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "", LAB_AGENT_ROL: rol ?? "", LAB_HOOFDCHECKOUT: realpathSync(HOOFD) };
    const invoer = { tool_name: "Bash", tool_input: { command }, cwd, ...extra };
    const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify(invoer)), env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stderr: p.stderr.toString() };
  };

  const SCHRIJVEND = [
    "git fetch",
    "git fetch origin main",
    "git checkout main",
    "git switch -c nieuw",
    "git reset --hard origin/main",
    "git restore a.txt",
    "git stash",
    "git stash push -u -m x",
    "git stash pop",
    "git clean -fd",
    "git pull",
    "git push origin eigen",
    "git commit -m x",
    "git merge origin/main",
    "git rebase origin/main",
    "git cherry-pick abc123",
    "git am x.patch",
    "git apply x.patch",
    "git worktree add ../x",
    "git worktree remove ../x",
    "git branch -D oud",
    "git branch -d oud",
    "pre-commit run --all-files",
    "pre-commit",
    "prettier --write .",
    "bunx prettier --write .",
    "oxfmt .",
    "npx oxfmt src",
    "biome format --write .",
    "biome check --write .",
    "black .",
    "isort .",
    "ruff format .",
    "ruff check --fix .",
    "eslint --fix .",
    "bun run format",
    "bun run lint --fix",
    "bun format",
    "bun install",
    "bun i",
    "FOO=1 git fetch",
    "git fetch && git status",
    "bash -c 'pre-commit run --all-files'",
    "echo klaar; pre-commit run",
    "cd sub && git fetch",
    "git -C . fetch",
    "git -C sub checkout main",
    `git -C ${HOOFD} fetch`,
    `cd ${HOOFD}/sub && bun install`,
  ];
  for (const c of SCHRIJVEND)
    test(`agent in de hoofdcheckout: weigert ${JSON.stringify(c)}`, () => {
      const r = run(c, HOOFD);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("schrijft in de gedeelde hoofdcheckout");
      expect(r.stderr).toContain("git -C <eigen pad>");
    });

  const DOOR = [
    "git status",
    "git log --oneline -5",
    "git show origin/main:a.txt",
    "git diff",
    "git diff --stat origin/main",
    "git stash list",
    "git branch",
    "git branch --list",
    "git worktree list",
    "cat a.txt",
    "ls -la",
    "rg --glob '!config.properties' --glob '!config.json' --glob '!.env*' foo .",
    "prettier --check .",
    "prettier a.txt",
    "oxfmt --check .",
    "black --check .",
    "ruff check .",
    "ruff format --check .",
    "eslint .",
    "biome check .",
    "bun run lint",
    "bun run format --check",
    "bun test scripts/lead/hooks/grenzen.test.ts",
    "pre-commit --version",
    "echo git fetch",
    "echo 'git fetch en pre-commit'",
    // een eigen map: -C of cd naar een clone of linked worktree
    `git -C ${CLONE} fetch`,
    `git -C ${WORKTREE} checkout -b x`,
    `cd ${CLONE} && pre-commit run --all-files`,
    `cd ${WORKTREE} && bun install`,
    `cd ${CLONE}/ && git fetch && bunx prettier --write .`,
    // niet te bepalen: toestaan
    "cd $EIGEN && pre-commit",
    "git -C $EIGEN fetch",
  ];
  for (const c of DOOR)
    test(`agent in de hoofdcheckout: laat door ${JSON.stringify(c)}`, () => {
      expect(run(c, HOOFD).code).toBe(0);
    });

  test("een cd weg en terug telt per segment", () => {
    expect(run(`cd ${CLONE} && cd ${HOOFD} && git fetch`, WORKTREE).code).toBe(2);
    expect(run(`cd ${HOOFD} && cd ${CLONE} && git fetch`, WORKTREE).code).toBe(0);
  }, RUIM);
  test("een linked worktree als cwd mag alles", () => {
    for (const c of ["git fetch", "git checkout -b x", "pre-commit run --all-files", "bun install", "prettier --write ."])
      expect(run(c, WORKTREE).code).toBe(0);
  }, RUIM);
  test("een clone als cwd mag alles", () => {
    for (const c of ["git fetch", "pre-commit run --all-files", "bun install"]) expect(run(c, CLONE).code).toBe(0);
  }, RUIM);
  test("een submap van een linked worktree mag", () => {
    expect(run("git fetch", join(WORKTREE, "sub")).code).toBe(0);
  });
  test("een submap van de hoofdcheckout telt als hoofdcheckout", () => {
    expect(run("pre-commit run", join(HOOFD, "sub")).code).toBe(2);
  });
  // 24 okt 2026: een tweede cd na een cd die niet te bepalen is (`cd $SCRATCH`) gaf join(None, …) en dus
  // "eigen fout (python-status 1)": de hook faalde dicht en blokkeerde legitiem werk (gc-query, gc-poort).
  test("een cd na een onbepaalbare cd crasht niet (gc-query: scratchpad, daarna git -C op de eigen worktree)", () => {
    for (const c of [`cd $SCRATCH && cd sub && git -C ${WORKTREE} status`, `cd "$SCRATCH"; cd sub; git -C ${WORKTREE} branch -d oud`]) {
      const r = run(c, WORKTREE);
      expect(r.stderr).not.toContain("eigen fout");
      expect(r.code).toBe(0);
    }
  }, RUIM);
  test("git branch -d vanuit een eigen worktree na een onbepaalbare cd crasht niet (gc-poort)", () => {
    for (const c of ["cd $TMP && cd .. && git branch -d oud", "cd $(mktemp -d) && cd x && git branch -d a b"]) {
      const r = run(c, WORKTREE);
      expect(r.stderr).not.toContain("eigen fout");
      expect(r.code).toBe(0);
    }
  }, RUIM);
  test("een absoluut pad na een onbepaalbare cd legt de werkmap weer vast: de hoofdcheckout blijft geweigerd", () => {
    expect(run(`cd $SCRATCH && cd ${HOOFD} && git fetch`, WORKTREE).code).toBe(2);
    expect(run(`cd $SCRATCH && cd ${HOOFD} && git branch -d oud`, WORKTREE).code).toBe(2);
    expect(run(`cd $SCRATCH && cd ${CLONE} && git fetch`, WORKTREE).code).toBe(0);
  }, RUIM);
  test("een kustomize-render na een onbepaalbare cd crasht niet maar wordt geweigerd", () => {
    const r = run("cd $SCRATCH && cd sub && kustomize build overlay", WORKTREE);
    expect(r.stderr).not.toContain("eigen fout");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("kustomize-render");
  }, RUIM);
  test("buiten een repo geen bezwaar", () => {
    expect(run("pre-commit run", BASIS).code).toBe(0);
  });
  test("de lead mag wel in de hoofdcheckout", () => {
    expect(run("git fetch", HOOFD, {}, "lead").code).toBe(0);
    expect(run("pre-commit run --all-files", HOOFD, {}, "lead").code).toBe(0);
  }, RUIM);
  test("zonder LAB_AGENT_ROL en zonder subagent-velden (Brian) mag het", () => {
    expect(run("git fetch", HOOFD, {}, null).code).toBe(0);
  });
  test("elke andere rol (sublead, vervolg, agent) wordt geweigerd", () => {
    for (const rol of ["sublead", "vervolg", "agent"]) expect(run("git fetch", HOOFD, {}, rol).code).toBe(2);
  }, RUIM);
  test("een subagent of fork wordt geweigerd, ook als de rol lead erft of ontbreekt", () => {
    expect(run("git fetch", HOOFD, { agent_id: "a1" }, "lead").code).toBe(2);
    expect(run("git fetch", HOOFD, { agent_type: "general-purpose" }, null).code).toBe(2);
    expect(run("git fetch", WORKTREE, { agent_id: "a1" }, "lead").code).toBe(0);
  }, RUIM);
  test("de melding noemt het commando, de map en wat te doen", () => {
    const m = run("pre-commit run --all-files", HOOFD).stderr;
    expect(m).toContain("`pre-commit`");
    expect(m).toContain(HOOFD);
    expect(m).toContain("eigen worktree of clone");
    expect(m).toContain("absoluut pad");
  }, RUIM);
});

describe("grenzen.sh: apply_patch van Codex", () => {
  const BASIS = realpathSync(mkdtempSync(join(tmpdir(), "grenzen-patch-")));
  const HOME = join(BASIS, "home");
  const VAULT = join(HOME, "vault-b-status");
  const HOOFD = join(BASIS, "hoofd");
  const WORKTREE = join(BASIS, "eigen-worktree");
  const WERK = join(BASIS, "werk");
  mkdirSync(join(VAULT, "archief"), { recursive: true });
  mkdirSync(WERK, { recursive: true });
  mkdirSync(HOOFD, { recursive: true });
  const git = (cwd: string, ...args: string[]) => {
    const env = { ...schoneEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  };
  git(HOOFD, "init", "-q", "-b", "main");
  writeFileSync(join(HOOFD, "a.txt"), "a\n");
  git(HOOFD, "add", ".");
  git(HOOFD, "commit", "-q", "-m", "init");
  git(HOOFD, "worktree", "add", "-q", "-b", "eigen", WORKTREE);
  afterAll(() => rmSync(BASIS, { recursive: true, force: true }));
  const GROOT = "x".repeat(50 * 1024);

  // rol: LAB_AGENT_ROL (null = niet gezet); extra: invoervelden (agent_id) en omgeving via env
  const run = (patch: unknown, cwd = WERK, rol: string | null = null, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
    const e = { ...schoneEnv(), HOME, LAB_GRENS_MERGE: "", LAB_AGENT_ROL: rol ?? "", LAB_HOOFDCHECKOUT: HOOFD, ...env };
    const invoer = { tool_name: "apply_patch", tool_input: { command: patch }, cwd, ...extra };
    const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify(invoer)), env: e, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stderr: p.stderr.toString() };
  };
  const wrap = (...delen: string[]) => `*** Begin Patch\n${delen.join("\n")}\n*** End Patch`;
  const add = (pad: string, tekst = "hi") => `*** Add File: ${pad}\n${tekst.split("\n").map((l) => `+${l}`).join("\n")}`;
  const upd = (pad: string, hunk = "@@\n-a\n+b") => `*** Update File: ${pad}\n${hunk}`;
  const del = (pad: string) => `*** Delete File: ${pad}`;

  test("de echte Codex-fixture (Add File y.txt) mag", () => {
    const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "codex-PreToolUse-apply_patch.json"), "utf8"));
    const e = { ...schoneEnv(), HOME, LAB_AGENT_ROL: "", LAB_GRENS_MERGE: "" };
    const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ ...fx, cwd: WERK })), env: e, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
  });
  test("gewone patches (Add, Update, Delete, Move to, meerdere bestanden) mogen", () => {
    expect(run(wrap(add("nieuw.txt"))).code).toBe(0);
    expect(run(wrap(upd("a.txt"))).code).toBe(0);
    expect(run(wrap(del("a.txt"))).code).toBe(0);
    expect(run(wrap(`*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+b`)).code).toBe(0);
    expect(run(wrap(add("x.txt"), upd("y.txt"), del("z.txt"))).code).toBe(0);
    expect(run(wrap(add("config.properties.example"), add(".env.example"))).code).toBe(0);
  });

  describe("sleutelbestanden", () => {
    const PADEN = ["config.properties", "sub/config.json", ".env", "apps/x/.env.local", ".config/klaarover/token", ".config/douane/x", ".config/agentwerkbank/x"];
    for (const pad of PADEN) {
      for (const [soort, maak] of [["Add", add], ["Update", upd], ["Delete", del]] as const) {
        test(`${soort} ${pad} wordt geweigerd`, () => {
          const r = run(wrap(maak(pad)));
          expect(r.code).toBe(2);
          expect(r.stderr).toContain("sleutelbestand");
        });
      }
    }
    test("Move to naar een sleutelbestand, en een Move vanaf een sleutelbestand, wordt geweigerd", () => {
      expect(run(wrap(`*** Update File: a.txt\n*** Move to: config.json\n@@\n-a\n+b`)).code).toBe(2);
      expect(run(wrap(`*** Update File: .env\n*** Move to: kopie.txt\n@@\n-a\n+b`)).code).toBe(2);
    });
    test("~/.claude en ~/.codex (ook relatief aan cwd of met ~) worden geweigerd", () => {
      expect(run(wrap(add(`${HOME}/.claude/settings.json`))).code).toBe(2);
      expect(run(wrap(add("~/.codex/config.toml"))).code).toBe(2);
      expect(run(wrap(upd("../home/.codex/hooks.json"))).code).toBe(2);
      expect(run(wrap(add("x.txt")), join(HOME, ".claude")).code).toBe(2);
    });
    test("een sleutelbestand verderop in een patch met meer bestanden weigert de hele patch", () => {
      expect(run(wrap(add("ok.txt"), upd("b.txt"), add("sub/.env"))).code).toBe(2);
    });
    test("een padstuk als .envrc of config.jsonl is geen sleutelbestand", () => {
      expect(run(wrap(add(".envrc"), add("config.jsonl"), add("env.txt"))).code).toBe(0);
    });
    test("een symlink naar een sleutelbestand wordt geweigerd", () => {
      symlinkSync(join(HOME, ".claude"), join(WERK, "schakel"));
      expect(run(wrap(add("schakel/settings.json"))).code).toBe(2);
    });
  });

  describe("vault-grootte", () => {
    const groot = (pad: string) => wrap(add(pad, GROOT));
    test("een nieuw te groot bestand wordt geweigerd, met grootte en oplossing", () => {
      const r = run(groot(join(VAULT, "PLAN-nieuw.md")));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("limiet voor een vaultnotitie is 40 KB");
      expect(r.stderr).toContain("splits per spoor");
    });
    test("paden relatief aan cwd tellen mee", () => {
      expect(run(groot("PLAN-rel.md"), VAULT).code).toBe(2);
      expect(run(groot("../home/vault-b-status/PLAN-rel.md"), WERK).code).toBe(2);
    });
    test("klein mag, precies op de grens mag, 1 byte erboven niet", () => {
      expect(run(wrap(add(join(VAULT, "klein.md"), "y".repeat(1000)))).code).toBe(0);
      // de patch telt een afsluitende nieuwe regel mee
      expect(run(wrap(add(join(VAULT, "g.md"), "z".repeat(40959)))).code).toBe(0);
      expect(run(wrap(add(join(VAULT, "g.md"), "z".repeat(40960)))).code).toBe(2);
    });
    test("een Update die een bestaande notitie boven de grens laat groeien wordt geweigerd; krimpen of gelijk mag", () => {
      writeFileSync(join(VAULT, "groei.md"), "a\n" + "q\n".repeat(20000));
      const voor = readFileSync(join(VAULT, "groei.md"), "utf8").length;
      expect(voor).toBeLessThan(40960);
      expect(run(wrap(upd(join(VAULT, "groei.md"), `@@\n a\n+${"w".repeat(2000)}`))).code).toBe(2);
      writeFileSync(join(VAULT, "al-groot.md"), "a\n" + "q\n".repeat(30000));
      expect(run(wrap(upd(join(VAULT, "al-groot.md"), "@@\n-a\n+b"))).code).toBe(0);
      expect(run(wrap(upd(join(VAULT, "al-groot.md"), "@@\n-q\n-q\n+q"))).code).toBe(0);
      expect(run(wrap(upd(join(VAULT, "al-groot.md"), `@@\n a\n+${"w".repeat(2000)}`))).code).toBe(2);
    });
    test("een Update waarvan de context niet in het bestand staat telt + en - regels", () => {
      writeFileSync(join(VAULT, "schat.md"), "x\n".repeat(20000));
      expect(run(wrap(upd(join(VAULT, "schat.md"), `@@\n-bestaat niet\n+${"w".repeat(30000)}`))).code).toBe(2);
      expect(run(wrap(upd(join(VAULT, "schat.md"), "@@\n-bestaat niet\n+kort"))).code).toBe(0);
    });
    test("Move to naar een vaultnotitie telt de grootte van het resultaat", () => {
      writeFileSync(join(WERK, "bron.md"), "a\n");
      const patch = wrap(`*** Update File: ${join(WERK, "bron.md")}\n*** Move to: ${join(VAULT, "verhuisd.md")}\n@@\n a\n+${"w".repeat(50000)}`);
      expect(run(patch).code).toBe(2);
    });
    test("Delete in de vault mag; lead.md, archief/ en niet-.md mogen groot; spoor/lead.md niet", () => {
      expect(run(wrap(del(join(VAULT, "groei.md")))).code).toBe(0);
      expect(run(groot(join(VAULT, "lead.md"))).code).toBe(0);
      expect(run(groot(join(VAULT, "archief", "oud.md"))).code).toBe(0);
      expect(run(groot(join(VAULT, "data.json"))).code).toBe(0);
      expect(run(groot(join(HOME, "elders", "plan.md"))).code).toBe(0);
      expect(run(groot(join(VAULT, "spoor", "lead.md"))).code).toBe(2);
      expect(run(groot(join(VAULT, "archief", "..", "groot2.md"))).code).toBe(2);
    });
    test("LAB_VAULT_MAX_KB wordt gevolgd", () => {
      expect(run(groot(join(VAULT, "a.md")), WERK, null, {}, { LAB_VAULT_MAX_KB: "100" }).code).toBe(0);
      expect(run(wrap(add(join(VAULT, "a.md"), "y".repeat(1024))), WERK, null, {}, { LAB_VAULT_MAX_KB: "0.5" }).code).toBe(2);
    });
  });

  describe("hoofdcheckout", () => {
    test("een agent mag geen bestand schrijven in de hoofdcheckout (Add, Update, Delete, Move, submap)", () => {
      for (const rol of ["agent", "sublead", "vervolg"]) {
        const r = run(wrap(add(join(HOOFD, "nieuw.txt"))), WERK, rol);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("gedeelde hoofdcheckout");
      }
      expect(run(wrap(upd(join(HOOFD, "a.txt"))), WERK, "agent").code).toBe(2);
      expect(run(wrap(del(join(HOOFD, "a.txt"))), WERK, "agent").code).toBe(2);
      expect(run(wrap(`*** Update File: ${join(WERK, "a.txt")}\n*** Move to: ${join(HOOFD, "b.txt")}\n@@\n-a\n+b`), WERK, "agent").code).toBe(2);
      expect(run(wrap(add(join(HOOFD, "nieuwe-map", "diep", "x.txt"))), WERK, "agent").code).toBe(2);
    });
    test("relatief aan een cwd in de hoofdcheckout telt ook", () => {
      expect(run(wrap(add("nieuw.txt")), HOOFD, "agent").code).toBe(2);
    });
    test("een eigen worktree en een map buiten een repo mogen", () => {
      expect(run(wrap(add("nieuw.txt")), WORKTREE, "agent").code).toBe(0);
      expect(run(wrap(add(join(WORKTREE, "x.txt"))), HOOFD, "agent").code).toBe(0);
      expect(run(wrap(add("nieuw.txt")), WERK, "agent").code).toBe(0);
    });
    test("de lead en Brian (zonder rol, zonder subagent-velden) mogen in de hoofdcheckout", () => {
      expect(run(wrap(add(join(HOOFD, "x.txt"))), HOOFD, "lead").code).toBe(0);
      expect(run(wrap(add(join(HOOFD, "x.txt"))), HOOFD, null).code).toBe(0);
    });
    test("een subagent wordt geweigerd, ook met rol lead of zonder rol", () => {
      expect(run(wrap(add(join(HOOFD, "x.txt"))), HOOFD, "lead", { agent_id: "a1" }).code).toBe(2);
      expect(run(wrap(add(join(HOOFD, "x.txt"))), HOOFD, null, { agent_type: "worker" }).code).toBe(2);
      expect(run(wrap(add(join(WORKTREE, "x.txt"))), WORKTREE, "lead", { agent_id: "a1" }).code).toBe(0);
    });
  });

  describe("herstelronde PR 673", () => {
    test("meerdere hunks: een hunk met alleen +regels stopt de telling niet (38 KB + 6000 tekens in een latere hunk)", () => {
      writeFileSync(join(VAULT, "n.md"), "a\n" + "q\n".repeat(19000) + "END\n");
      const patch = wrap(upd(join(VAULT, "n.md"), `@@\n+x\n@@\n END\n+${"w".repeat(6000)}`));
      expect(run(patch).code).toBe(2);
      // dezelfde vorm, klein: mag
      expect(run(wrap(upd(join(VAULT, "n.md"), "@@\n+x\n@@\n END\n+kort"))).code).toBe(0);
    });
    test("een Add File in .git van de hoofdcheckout (hooks) wordt geweigerd, absoluut en vanuit een worktree", () => {
      const r = run(wrap(add(join(HOOFD, ".git", "hooks", "pre-push"))), HOOFD, "werker");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("gedeelde hoofdcheckout");
      expect(run(wrap(add(".git/hooks/pre-push")), HOOFD, "werker").code).toBe(2);
      expect(run(wrap(add("../hoofd/.git/hooks/pre-push")), WORKTREE, "werker").code).toBe(2);
      expect(run(wrap(add(".git/config")), HOOFD, "werker").code).toBe(2);
      expect(run(wrap(add("../hoofd/.git/hooks/pre-push")), WORKTREE, "lead").code).toBe(0);
    });
    test(".env.production.local en .env.local zijn sleutelbestanden; .example en .envrc niet", () => {
      expect(run(wrap(add(".env.production.local"))).code).toBe(2);
      expect(run(wrap(add("a/.env.staging.eu"))).code).toBe(2);
      expect(run(wrap(add(".env.production.example"))).code).toBe(0);
      expect(run(wrap(add(".envrc"))).code).toBe(0);
    });
    test("hoofdletters: .ENV, Config.JSON, CONFIG.PROPERTIES en ~/.CLAUDE tellen als sleutel", () => {
      for (const pad of [".ENV", "Config.JSON", "CONFIG.PROPERTIES", ".Env.Local", ".CONFIG/Klaarover/x", `${HOME}/.CLAUDE/x`, `${HOME}/.Codex/x`]) {
        expect(run(wrap(add(pad))).code).toBe(2);
      }
    });
    test("hoofdletters: GROOT.MD in de vault valt onder de grootteregel, LEAD.MD en ARCHIEF/ onder de uitzonderingen", () => {
      expect(run(wrap(add(join(VAULT, "GROOT.MD"), GROOT))).code).toBe(2);
      expect(run(wrap(add(join(VAULT, "Plan.Md"), GROOT))).code).toBe(2);
      expect(run(wrap(add(join(VAULT, "LEAD.MD"), GROOT))).code).toBe(0);
      expect(run(wrap(add(join(VAULT, "Archief", "x.md"), GROOT))).code).toBe(0);
    });
    test("$CODEX_HOME wordt beschermd naast ~/.codex", () => {
      const ch = join(BASIS, "ander-codex-home");
      mkdirSync(ch, { recursive: true });
      expect(run(wrap(add(join(ch, "config.toml"))), WERK, null, {}, { CODEX_HOME: ch }).code).toBe(2);
      expect(run(wrap(add(join(ch, "config.toml")))).code).toBe(0);
    });
    test("N1: .git in andere hoofdletters, en een .git-pad in kleine letters, tellen als hoofdcheckout (puur op strings, dus ook op Linux)", () => {
      expect(run(wrap(add(".GIT/hooks/pre-push")), HOOFD, "werker").code).toBe(2);
      expect(run(wrap(add(`${HOOFD.toLowerCase()}/.git/config`)), WORKTREE, "werker").code).toBe(2);
      expect(run(wrap(add(`${HOOFD.toUpperCase()}/.Git/hooks/x`)), WORKTREE, "werker").code).toBe(2);
      // Buiten .git beslist git; alleen op macOS (APFS, hoofdletterongevoelig) bestaat het pad in kleine letters.
      // Op Linux is het fs hoofdlettergevoelig en bestaat dat pad niet, dus daar is dit geen hoofdcheckout.
      if (process.platform === "darwin") {
        expect(run(wrap(add(`${HOOFD.toLowerCase()}/nieuw.txt`)), WORKTREE, "werker").code).toBe(2);
      }
      expect(run(wrap(add(`${HOOFD.toLowerCase()}/.git/config`)), WORKTREE, "lead").code).toBe(0);
    });
    test("N2: een min-regel die niet exact matcht telt niet als krimp (38 KB + fuzzy min van 5000 en plus van 5500)", () => {
      writeFileSync(join(VAULT, "fuzzy.md"), "a\n" + "q\n".repeat(19500));
      expect(run(wrap(upd(join(VAULT, "fuzzy.md"), `@@\n-${"e".repeat(5000)}\n+${"w".repeat(5500)}`))).code).toBe(2);
      // exact matchende min-regel blijft krimp
      expect(run(wrap(upd(join(VAULT, "fuzzy.md"), "@@\n-a\n+b"))).code).toBe(0);
    });
    test("een symlink naar de vault omzeilt de grootteregel niet", () => {
      symlinkSync(VAULT, join(WERK, "vaultlink"));
      expect(run(wrap(add("vaultlink/via-link.md", GROOT))).code).toBe(2);
    });
    test("een pad dat met ~ begint wordt niet aangevuld maar geweigerd, met uitleg", () => {
      for (const pad of ["~/vault-b-status/x.md", "~/werk/x.txt", "~brian/x.txt"]) {
        const r = run(wrap(add(pad)));
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("met ~ begint");
      }
      expect(run(wrap(`*** Update File: a.txt\n*** Move to: ~/x.txt\n@@\n-a\n+b`)).code).toBe(2);
    });
  });

  describe("een patch die niet te lezen is wordt geweigerd, met uitleg", () => {
    const SLECHT: Array<[string, unknown]> = [
      ["zonder Begin Patch", "*** Add File: x.txt\n+hi\n*** End Patch"],
      ["zonder End Patch", "*** Begin Patch\n*** Add File: x.txt\n+hi"],
      ["leeg", ""],
      ["alleen Begin en End", "*** Begin Patch\n*** End Patch"],
      ["geen tekst maar een lijst", ["*** Begin Patch"]],
      ["onbekende kop", wrap("*** Rename File: x.txt")],
      ["regel buiten een bestand", wrap("+hi")],
      ["Add met een regel zonder plus", wrap("*** Add File: x.txt\nhi")],
      ["regel zonder + - of spatie", wrap("*** Update File: x.txt\n@@\nfout")],
      ["Move to zonder Update", wrap("*** Add File: x.txt\n*** Move to: y.txt")],
      ["Delete met inhoud", wrap("*** Delete File: x.txt\n-a")],
      ["leeg pad", wrap("*** Add File: \n+hi")],
    ];
    for (const [naam, patch] of SLECHT) {
      test(naam, () => {
        const r = run(patch);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("apply_patch niet te lezen");
        expect(r.stderr).toContain("*** Begin Patch");
      });
    }
    test("zonder command-veld", () => {
      const e = { ...schoneEnv(), HOME, LAB_AGENT_ROL: "", LAB_GRENS_MERGE: "" };
      const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "apply_patch", tool_input: {}, cwd: WERK })), env: e, stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode).toBe(2);
    });
  });

  test("een tool die niet apply_patch heet wordt niet als patch gelezen", () => {
    const e = { ...schoneEnv(), HOME, LAB_AGENT_ROL: "", LAB_GRENS_MERGE: "" };
    const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "mcp__x__y", tool_input: { command: "onzin" }, cwd: WERK })), env: e, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
  });
});

describe("python draait geïsoleerd (-I): de procesmap telt niet", () => {
  // Een onleesbare cwd liet elke import in python met PermissionError falen (de hook weigerde dan ALLES), en een json.py in de cwd
  // werd als hook-code geïmporteerd. De invoer-cwd (d["cwd"]) is wat de logica gebruikt.
  const alsRoot = process.getuid?.() === 0;
  const invoer = JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hallo" }, cwd: EIGEN_TAK });
  const hookEnv = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "", LAB_AGENT_ROL: "" };
  /** Draait de hook met `procmap` als procesmap; bij `dicht` wordt die map ONDER het proces onleesbaar (chmod 000, zoals in de Mirku21-sessie). */
  function inMap(hook: string, procmap: string, dicht: boolean) {
    const p = Bun.spawnSync(["bash", "-c", `cd "$PROCMAP" && { [ "$DICHT" = 1 ] && chmod 000 . || true; } && exec bash "$HOOK"`], {
      stdin: new TextEncoder().encode(invoer),
      env: { ...hookEnv, PROCMAP: procmap, DICHT: dicht ? "1" : "0", HOOK: hook },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (dicht) chmodSync(procmap, 0o755);
    return { code: p.exitCode, stderr: p.stderr.toString() };
  }
  const tijdelijk = () => mkdtempSync(join(tmpdir(), "grenzen-pymap-"));

  test("een onleesbare procesmap: een onschuldige Bash-aanroep gaat door (rc 0; als root niet te maken)", () => {
    if (alsRoot) return; // root leest elke map
    const map = tijdelijk();
    try {
      const r = inMap(HOOK, map, true);
      expect(r.stderr).not.toContain("Geweigerd"); // bash zelf meldt wel een getwd-waarschuwing; de hook mag niet weigeren
      expect(r.code).toBe(0);
    } finally {
      chmodSync(map, 0o755);
      rmSync(map, { recursive: true, force: true });
    }
  });

  test("een json.py in de procesmap wordt niet geïmporteerd (geen markeerbestand)", () => {
    const map = tijdelijk();
    const merk = join(map, "MARK-JSON");
    try {
      writeFileSync(join(map, "json.py"), `open(${JSON.stringify(merk)}, "w").write("gedraaid")\nraise ImportError("nep")\n`);
      const r = inMap(HOOK, map, false);
      expect(existsSync(merk)).toBe(false);
      expect(r.code).toBe(0);
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });

  /** Een kopie van de hook zonder `-I`, in een eigen tijdelijke map. */
  const zonderI = () => {
    const hooktekst = readFileSync(HOOK, "utf8");
    expect(hooktekst).toContain("/usr/bin/python3 -I -c");
    const map = tijdelijk();
    const kopie = join(map, "grenzen-zonder-I.sh");
    writeFileSync(kopie, hooktekst.replace("/usr/bin/python3 -I -c", "/usr/bin/python3 -c"));
    return { map, kopie };
  };

  test("mutatie: zonder -I importeert python de json.py uit de procesmap wel", () => {
    const { map, kopie } = zonderI();
    const werk = tijdelijk();
    const merk = join(werk, "MARK-JSON");
    try {
      writeFileSync(join(werk, "json.py"), `open(${JSON.stringify(merk)}, "w").write("gedraaid")\nraise ImportError("nep")\n`);
      inMap(kopie, werk, false);
      expect(existsSync(merk)).toBe(true);
    } finally {
      rmSync(map, { recursive: true, force: true });
      rmSync(werk, { recursive: true, force: true });
    }
  });

  test("mutatie (alleen macOS): zonder -I faalt de hook bij een onleesbare procesmap", () => {
    // Alleen op macOS: daar geeft python met `''` op sys.path een PermissionError bij een onleesbare cwd. Op Linux (CI) blijft
    // die import werken (de map wordt alleen niet gelezen), dus daar is deze mutatie niet rood te krijgen.
    if (process.platform !== "darwin" || alsRoot) return;
    const { map, kopie } = zonderI();
    const dicht = tijdelijk();
    try {
      expect(inMap(kopie, dicht, true).code).toBe(2);
    } finally {
      chmodSync(dicht, 0o755);
      rmSync(dicht, { recursive: true, force: true });
      rmSync(map, { recursive: true, force: true });
    }
  });
});
