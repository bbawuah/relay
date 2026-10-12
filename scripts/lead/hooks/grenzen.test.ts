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
  // geldige dubbele quote met \" erin: inerte tekst, geen commando
  'git commit -m "a\\" ; ./uitrollen.sh ; \\""',
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
  test("Read van een sleutelbestand wordt geweigerd, .example mag", () => {
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/.config/klaarover/token" } }).code).toBe(2);
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/x/.env" } }).code).toBe(2);
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/x/.env.example" } }).code).toBe(0);
  });
  test("ongeldige invoer faalt open", () => {
    expect(Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode("geen json"), env: schoneEnv() }).exitCode).toBe(0);
  });
});
