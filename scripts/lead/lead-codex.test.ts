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
find "$LAB_LEAD_STAAT/identiteit" -type f -exec cat {} \\; >> "$FAKE_LOG"
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
  test("gebruikt bestaande vendorconfig, start met identiteit en ruimt die daarna op", () => {
    const r = run({ CODEX_HOME: "/onveilig-profiel" });
    expect(r.exitCode).toBe(0);
    const regels = readFileSync(log, "utf8");
    const werkruimte = realpathSync(werkboom);
    expect(regels).toContain(identiteitPad(staat, werkruimte));
    expect(regels).toContain("home=/onveilig-profiel");
    expect(regels).toContain("role=lead-proef");
    expect(regels).toContain('"rol": "lead-proef"');
    expect(regels).toContain("naam=codex-lead");
    expect(regels).toContain("lead=codex-lead");
    expect(regels).toContain(`args=-C ${realpathSync(werkboom)} start-opdracht`);
    const pad = identiteitPad(staat, werkruimte);
    expect(existsSync(pad)).toBe(false);
    expect(readdirSync(join(staat, "identiteit"))).toEqual([]);
  });

  test("weigert een bestaande werkruimte-identiteit", () => {
    schrijfIdentiteit(staat, realpathSync(werkboom), { naam: "andere-lead", rol: "lead-proef", lead: "andere-lead", opdracht: "", spawn_id: "oud", ts: Date.now() });
    const bestaand = run();
    expect(bestaand.exitCode).toBe(1);
    expect(bestaand.stderr.toString()).toContain("identiteit bestaat al");
  });

  test("verhoogt het compatibiliteitslabel niet via de geërfde rol", () => {
    const r = run({ LAB_AGENT_ROL: "lead" });
    expect(r.exitCode).toBe(0);
    const regels = readFileSync(log, "utf8");
    expect(regels).toContain("role=lead-proef");
    expect(regels).toContain('"rol": "lead-proef"');
  });
});
