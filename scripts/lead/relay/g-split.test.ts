import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "g-split.sh");
const tijdelijke: string[] = [];
const map = (naam: string) => {
  const p = mkdtempSync(join(tmpdir(), `g-split-${naam}-`));
  tijdelijke.push(p);
  return p;
};
const envZonderGit = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return env as Record<string, string>;
};
afterEach(() => tijdelijke.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: envZonderGit() });

test("bouwt in een tijdelijk HOME uit een clone, zonder remote, en vervangt alleen een gemarkeerde relay", () => {
  const dir = map("bouw");
  const home = join(dir, "home");
  const bron = join(dir, "bron");
  const origin = join(dir, "origin.git");
  const bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bron);
  mkdirSync(bin);
  mkdirSync(join(bron, "scripts", "lead", "hooks"), { recursive: true });
  mkdirSync(join(bron, "agents", "skills"), { recursive: true });
  writeFileSync(join(bron, "scripts", "lead", "hooks", "grenzen.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(bron, "scripts", "lead", "hooks", "hook.sh"), "#!/usr/bin/env bash\n");
  // `bun test tests` is een naamfilter, geen pad: dit bestand buiten tests/ mag de relay-poort niet raken.
  writeFileSync(join(bron, "scripts", "lead", "kapot-tests.test.ts"), 'import { test } from "bun:test";\ntest("buiten tests/", () => { throw new Error("hoort niet in de poort"); });\n');
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(bron, "init", "-q", "-b", "main");
  git(bron, "add", ".");
  git(bron, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "bron");
  git(bron, "remote", "add", "origin", origin);
  git(bron, "push", "-q", "origin", "main");
  const nepGit = join(bin, "git");
  writeFileSync(nepGit, `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = filter-repo ]; then
    # Filter-repo zelf verwijdert origin; de splitter moet dat idempotent accepteren.
    for ((i=1; i <= $#; i++)); do
      [ "\${!i}" = -C ] && { j=$((i + 1)); "${Bun.which("git")}" -C "\${!j}" remote remove origin; }
    done
    exit 0
  fi
done
exec "${Bun.which("git")}" "$@"
`);
  chmodSync(nepGit, 0o755);
  const nepBun = join(bin, "bun");
  writeFileSync(nepBun, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$BUN_LOG\"\n");
  chmodSync(nepBun, 0o755);
  const bunLog = join(dir, "bun.log");
  const doel = join(home, "relay");
  mkdirSync(doel);
  writeFileSync(join(doel, ".relay-split-marker"), "gemaakt-door=g-split.sh\n");
  writeFileSync(join(doel, "oud.txt"), "oude relay\n");
  const run = Bun.spawnSync(["bash", SCRIPT], {
    env: { ...envZonderGit(), HOME: home, CONCEPT_UITVOEREN: "JA", RELAY_BRON_REPO: bron, RELAY_GIT: nepGit, RELAY_BUN: nepBun, BUN_LOG: bunLog, TMPDIR: dir },
  });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(doel, ".relay-split-marker"), "utf8")).toContain("gemaakt-door");
  expect(existsSync(join(doel, "oud.txt"))).toBe(false);
  expect(git(doel, "remote").stdout.toString().trim()).toBe("");
  expect(readFileSync(bunLog, "utf8")).toBe("run poort\n");
  const backup = readdirSync(home).find((naam) => naam.startsWith("relay.voor-split-"));
  expect(backup).toContain(".voor-split-");
  expect(readFileSync(join(home, backup!, "oud.txt"), "utf8")).toBe("oude relay\n");
  // De gegenereerde poort moet met de echte bun slagen; de nep-bun hierboven bewijst dat niet.
  const poort = Bun.spawnSync([process.execPath, "run", "poort"], { cwd: doel, env: envZonderGit() });
  expect(poort.exitCode, poort.stderr.toString()).toBe(0);
});

test("weigert een bestaande ~/relay zonder eigen marker zonder iets te overschrijven", () => {
  const home = map("home");
  const doel = join(home, "relay");
  mkdirSync(doel);
  writeFileSync(join(doel, "behouden.txt"), "niet overschrijven\n");
  const run = Bun.spawnSync(["bash", SCRIPT], { env: { ...envZonderGit(), HOME: home, CONCEPT_UITVOEREN: "JA" } });
  expect(run.exitCode).not.toBe(0);
  expect(readFileSync(join(doel, "behouden.txt"), "utf8")).toBe("niet overschrijven\n");
  expect(run.stderr.toString()).toContain("zonder .relay-split-marker");
});

test("droog schrijft niets, ook niet zonder uitvoervlag", () => {
  const home = map("droog");
  const run = Bun.spawnSync(["bash", SCRIPT, "--droog"], { env: { ...envZonderGit(), HOME: home } });
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(home, "relay"))).toBe(false);
  expect(run.stdout.toString()).toContain("geen bestanden geschreven");
});

test("weigert vóór backup of clone duidelijk wanneer git filter-repo ontbreekt", () => {
  const home = map("geen-filter");
  const bin = join(home, "bin");
  const doel = join(home, "relay");
  mkdirSync(bin);
  mkdirSync(doel);
  writeFileSync(join(doel, ".relay-split-marker"), "gemaakt-door=g-split.sh\n");
  writeFileSync(join(doel, "oud.txt"), "behouden\n");
  const zonderFilter = join(bin, "git");
  writeFileSync(zonderFilter, `#!/usr/bin/env bash
for a in "$@"; do [ "$a" = filter-repo ] && exit 1; done
exec "${Bun.which("git")}" "$@"
`);
  chmodSync(zonderFilter, 0o755);
  const run = Bun.spawnSync(["bash", SCRIPT], {
    env: { ...envZonderGit(), HOME: home, CONCEPT_UITVOEREN: "JA", RELAY_GIT: zonderFilter },
  });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain("git filter-repo ontbreekt");
  expect(readFileSync(join(doel, "oud.txt"), "utf8")).toBe("behouden\n");
  expect(readdirSync(home).filter((naam) => naam.startsWith("relay.voor-split-")).length).toBe(0);
});
