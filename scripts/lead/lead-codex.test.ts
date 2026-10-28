import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { schoneEnv } from "../test-integriteit";
import { identiteitPad, schrijfIdentiteit, wisIdentiteit } from "./hooks/register";
import { hookOmgeving, identiteitEnv } from "./hooks/codex-wrap";

const STARTER = join(import.meta.dir, "lead-codex.sh");
let dir: string;
let bin: string;
let staat: string;
let log: string;
let repo: string;
let werkboom: string;

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...schoneEnv(), GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-codex-test-"));
  bin = join(dir, "bin");
  staat = join(dir, "staat");
  log = join(dir, "codex.log");
  repo = join(dir, "hoofdcheckout");
  werkboom = join(dir, "lead-worktree");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "test\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "lead/test", werkboom);
  Bun.spawnSync(["mkdir", bin]);
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
if [ "$1 $2" = "login status" ]; then exit "\${FAKE_LOGIN_CODE:-0}"; fi
find "$LAB_LEAD_STAAT/identiteit" -type f -print > "$FAKE_LOG"
printf 'home=%s\\nrole=%s\\nnaam=%s\\nlead=%s\\nargs=%s\\n' "$CODEX_HOME" "$LAB_AGENT_ROL" "$LAB_AGENT_NAAM" "$LAB_LEAD_NAAM" "$*" >> "$FAKE_LOG"
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/sh
if [ "\${FAKE_VERWACHT_PROFIEL:-}" = 1 ]; then
  test "$1" = "$FAKE_CONTROLE" || exit 91
  test -f "$2" || exit 92
  grep -Fx 'sandbox_mode = "danger-full-access"' "$2" >/dev/null || exit 93
  grep -Fx 'approval_policy = "on-request"' "$2" >/dev/null || exit 94
fi
exit \${FAKE_BUN_CODE:-0}
`,
  );
  chmodSync(join(bin, "bun"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (extra: Record<string, string> = {}, args = ["start-opdracht"]) => {
  // Een CI-run kan zelf LAB_*-variabelen erven. De startertest moet uitsluitend
  // zijn eigen tijdelijke lead-sessie meten, nooit die van de aanroeper.
  const schoon = Object.fromEntries(Object.entries(schoneEnv()).filter(([k]) => !k.startsWith("LAB_")));
  return Bun.spawnSync(["bash", STARTER, ...args], {
    cwd: werkboom,
    env: { ...schoon, PATH: `${bin}:${process.env.PATH}`, HOME: dir, LAB_LEAD_STAAT: staat, FAKE_LOG: log, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
};

describe("lead-codex.sh", () => {
  test("controleert het profiel en de inlog, start met lead-proef-identiteit en ruimt die daarna op", () => {
    const r = run({ CODEX_HOME: "/onveilig-profiel" });
    expect(r.exitCode).toBe(0);
    const regels = readFileSync(log, "utf8");
    const werkruimte = realpathSync(dirname(werkboom));
    expect(regels).toContain(identiteitPad(staat, werkruimte));
    expect(regels).toContain(`home=${join(dir, ".codex-lead")}`);
    expect(regels).toContain("role=lead-proef");
    expect(regels).toContain("naam=codex-lead");
    expect(regels).toContain("lead=codex-lead");
    expect(regels).toContain(`args=-C ${realpathSync(dirname(werkboom))} start-opdracht`);
    const pad = identiteitPad(staat, werkruimte);
    expect(existsSync(pad)).toBe(false);
    expect(readdirSync(join(staat, "identiteit"))).toEqual([]);
  });

  test("start niet zonder groen profiel of inlog en laat dan geen identiteit achter", () => {
    const profiel = run({ FAKE_BUN_CODE: "1" });
    expect(profiel.exitCode).toBe(1);
    expect(profiel.stderr.toString()).toContain("profiel");
    expect(existsSync(join(staat, "identiteit"))).toBe(false);
    const login = run({ FAKE_LOGIN_CODE: "1" });
    expect(login.exitCode).toBe(1);
    expect(login.stderr.toString()).toContain("geen Codex-inlog");
    expect(existsSync(join(staat, "identiteit"))).toBe(false);
  });

  test("start met een danger-full-access-profiel zonder CLI-sandboxomweg", () => {
    const profiel = join(dir, ".codex-lead");
    mkdirSync(profiel, { recursive: true });
    writeFileSync(join(profiel, "config.toml"), 'sandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n');
    const r = run({ FAKE_VERWACHT_PROFIEL: "1", FAKE_CONTROLE: join(import.meta.dir, "hooks", "codex-controle.ts") });
    expect(r.exitCode).toBe(0);
    const regels = readFileSync(log, "utf8");
    expect(regels).toContain(`home=${profiel}`);
    expect(regels).toContain(`args=-C ${realpathSync(dirname(werkboom))} start-opdracht`);
    expect(regels).not.toContain("--sandbox");
  });

  test("de werkruimte-identiteit bindt aan één SessionStart; hoofdcheckout en zusterworktree krijgen geen lek", () => {
    const werkruimte = join(dir, "werkruimte");
    const hoofd = join(werkruimte, "lab-bawuah");
    const ander = join(werkruimte, "andere-worktree");
    mkdirSync(hoofd, { recursive: true });
    mkdirSync(ander);
    const echt = realpathSync(werkruimte);
    const echtHoofd = realpathSync(hoofd);
    const echtAnder = realpathSync(ander);
    schrijfIdentiteit(staat, echt, { naam: "codex-lead", rol: "lead-proef", lead: "codex-lead", opdracht: "", spawn_id: "lead", ts: Date.now() });
    const env = { LAB_LEAD_STAAT: staat, LAB_SPAWN_ID: "lead" };
    expect(identiteitEnv(env, echtHoofd, Date.now(), "andere-sessie")).toEqual({});
    expect(hookOmgeving(env, echtHoofd, Date.now(), "lead-sessie", "SessionStart").LAB_AGENT_ROL).toBe("lead-proef");
    expect(identiteitEnv(env, echtAnder, Date.now(), "lead-sessie").LAB_AGENT_ROL).toBe("lead-proef");
    expect(identiteitEnv(env, echtAnder, Date.now(), "andere-sessie")).toEqual({});
    wisIdentiteit(staat, echtAnder, "lead");
    expect(identiteitEnv(env, echtAnder, Date.now(), "lead-sessie").LAB_AGENT_ROL).toBe("lead-proef");
    schrijfIdentiteit(staat, echtAnder, { naam: "werker", rol: "agent", lead: "codex-lead", opdracht: "", spawn_id: "werker", ts: Date.now() });
    expect(identiteitEnv({ LAB_LEAD_STAAT: staat }, echtAnder).LAB_AGENT_ROL).toBe("agent");
  });

  test("accepteert alleen één gewone prompt en weigert alle Codex-vlaggen", () => {
    expect(run({},).exitCode).toBe(0);
    for (const args of [["-C", "/andere", "prompt"], ["--cd=/andere"], ["--add-dir", "/tmp"], ["--add-dir=/tmp"], ["-ckey=val"], ["-p", "profiel"], ["--profile", "profiel"], ["--full-auto"], ["--enable", "x"]]) {
      const vlag = run({}, args);
      expect(vlag.exitCode).toBe(1);
      expect(vlag.stderr.toString()).toContain("alleen één prompt");
    }
  });

  test("weigert een bestaande werkruimte-identiteit", () => {
    schrijfIdentiteit(staat, realpathSync(dirname(werkboom)), { naam: "andere-lead", rol: "lead-proef", lead: "andere-lead", opdracht: "", spawn_id: "oud", ts: Date.now() });
    const bestaand = run();
    expect(bestaand.exitCode).toBe(1);
    expect(bestaand.stderr.toString()).toContain("identiteit bestaat al");
  });
});
