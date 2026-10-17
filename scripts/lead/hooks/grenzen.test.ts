import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schoneEnv } from "../../test-integriteit";

// Draait de hook met JSON op stdin. GRENZEN_HOOK kan naar een andere kopie wijzen (rood-op-basis).
const HOOK = process.env.GRENZEN_HOOK ?? join(import.meta.dir, "grenzen.sh");
// De oude hook (zoals die in ~/.claude stond) als orakel voor de eigenschapstest.
const OUD = join(import.meta.dir, "fixtures", "grenzen-oud.sh");

function draai(invoer: unknown, hook = HOOK) {
  const env = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "" };
  const p = Bun.spawnSync(["bash", hook], { stdin: new TextEncoder().encode(JSON.stringify(invoer)), env, stdout: "pipe", stderr: "pipe" });
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
  test("ongeldige invoer faalt dicht (exit 1, geen 0 of 2)", () => {
    for (const t of ["geen json", "", '{"tool_name": "Bash"']) {
      const r = rauw(t);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("faalt dicht");
    }
  });
  test("een kapotte python-stap faalt dicht (exit 1)", () => {
    // geldige JSON van de verkeerde vorm: de python-stap crasht (status 1) in plaats van te beslissen
    for (const t of ["[1]", '{"tool_name": "Bash", "tool_input": "x"}', '{"tool_name": "Read", "tool_input": ["x"]}']) {
      const r = rauw(t);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("grenzen.sh: eigen fout (python-status");
    }
  });
});
