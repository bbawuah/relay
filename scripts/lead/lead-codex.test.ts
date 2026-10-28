import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { schoneEnv } from "../test-integriteit";
import { identiteitPad } from "./hooks/register";

const STARTER = join(import.meta.dir, "lead-codex.sh");
let dir: string;
let bin: string;
let staat: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-codex-test-"));
  bin = join(dir, "bin");
  staat = join(dir, "staat");
  log = join(dir, "codex.log");
  Bun.spawnSync(["mkdir", bin]);
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit ${FAKE_BUN_CODE:-0}\n");
  chmodSync(join(bin, "bun"), 0o755);
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
if [ "$1 $2" = "login status" ]; then exit "\${FAKE_LOGIN_CODE:-0}"; fi
find "$LAB_LEAD_STAAT/identiteit" -type f -print > "$FAKE_LOG"
printf 'home=%s\\nrole=%s\\nnaam=%s\\nlead=%s\\nargs=%s\\n' "$CODEX_HOME" "$LAB_AGENT_ROL" "$LAB_AGENT_NAAM" "$LAB_LEAD_NAAM" "$*" >> "$FAKE_LOG"
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (extra: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", STARTER, "start-opdracht"], {
    cwd: process.cwd(),
    env: { ...schoneEnv(), PATH: `${bin}:${process.env.PATH}`, HOME: dir, LAB_LEAD_STAAT: staat, FAKE_LOG: log, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });

describe("lead-codex.sh", () => {
  test("controleert het profiel en de inlog, start met lead-proef-identiteit en ruimt die daarna op", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    const regels = readFileSync(log, "utf8");
    expect(regels).toContain(`home=${join(dir, ".codex-lead")}`);
    expect(regels).toContain("role=lead-proef");
    expect(regels).toContain("naam=codex-lead");
    expect(regels).toContain("lead=codex-lead");
    expect(regels).toContain(`args=-C ${dirname(process.cwd())} start-opdracht`);
    const pad = identiteitPad(staat, process.cwd());
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
});
