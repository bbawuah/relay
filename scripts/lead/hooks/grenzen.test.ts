import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { schoneEnv } from "../../test-integriteit";

// Draait de hook met JSON op stdin. GRENZEN_HOOK kan naar een andere kopie wijzen (rood-op-basis: de oude hook).
const HOOK = process.env.GRENZEN_HOOK ?? join(import.meta.dir, "grenzen.sh");

function draai(invoer: unknown) {
  const env = { ...schoneEnv(), HOME: "/nonexistent-grenzen-test", LAB_GRENS_MERGE: "" };
  const p = Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode(JSON.stringify(invoer)), env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString() };
}
const bash = (command: string) => draai({ tool_name: "Bash", tool_input: { command } });

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
  // ongebalanceerde quote: streng terugvallen
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
  'echo "$(date) uitrollen.sh"',
  "grep uitrollen.sh x",
  "git diff apps/x/scripts/uitrollen.sh",
  "cat apps/x/scripts/uitrollen.sh",
  'git commit -m "kill: pkill -f x\npkill -f y"',
  "kill 123",
];

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
  test("Read van een sleutelbestand wordt geweigerd, .example mag", () => {
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/.config/klaarover/token" } }).code).toBe(2);
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/x/.env" } }).code).toBe(2);
    expect(draai({ tool_name: "Read", tool_input: { file_path: "/h/x/.env.example" } }).code).toBe(0);
  });
  test("ongeldige invoer faalt open", () => {
    expect(Bun.spawnSync(["bash", HOOK], { stdin: new TextEncoder().encode("geen json"), env: schoneEnv() }).exitCode).toBe(0);
  });
});
