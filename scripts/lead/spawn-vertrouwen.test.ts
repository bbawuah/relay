import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Echte tmux, maar alleen een wegwerpserver: elke aanroep van spawn.sh gaat via een `tmux`-wrapper die
// `-L spawntest-<pid> -f /dev/null` voorzet. TMUX/TMUX_PANE zijn leeg, de echte server wordt nooit geraakt.
// Het nep-spawnscript start een pane die eerst de echte vertrouwenstekst van Claude Code toont (opgehaald
// met `claude` in een nieuwe map) en die na enkele seconden vervangt door de prompt.

const SPAWN = join(import.meta.dir, "spawn.sh");
const ECHTE_TMUX = Bun.which("tmux") ?? "tmux";
const sock = `spawntest-${process.pid}`;

let dir: string;
let bin: string;

const schoon = (): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) e[k] = v;
  return e;
};

const tmux = (...a: string[]) => Bun.spawnSync([ECHTE_TMUX, "-L", sock, "-f", "/dev/null", ...a], { env: { ...schoon(), TMUX: "", TMUX_PANE: "" } });

const TEKST = "Quick safety check: Is this a project you created or one you trust?\\n\\n ❯ No, exit\\n   Yes, I trust this folder\\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spawn-vertrouwen-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  const maak = (naam: string, tekst: string) => {
    writeFileSync(join(bin, naam), tekst);
    chmodSync(join(bin, naam), 0o755);
  };
  maak("tmux", `#!/usr/bin/env bash\nexec "${ECHTE_TMUX}" -L ${sock} -f /dev/null "$@"\n`);
  // De pane: vertrouwenstekst, na $TRUST_SECONDEN de prompt, daarna leest hij de startzin en toont een tool-aanroep.
  maak(
    "pane.sh",
    `#!/usr/bin/env bash\nprintf '${TEKST}'\nsleep "$(cat "${dir}/trust-sec")"\nclear\nprintf 'auto mode\\n'\nprintf '│ ❯ \\n'\nIFS= read -r zin\nprintf '%s\\n' "$zin" > "${dir}/getypt.txt"\nprintf '⏺ Read(opdracht.md)\\n'\nsleep 30\n`,
  );
  maak("nep-agent-spawn.sh", `#!/usr/bin/env bash\ntmux new-window -d -P -F '#{pane_id}' "${join(bin, "pane.sh")}"\n`);
  tmux("new-session", "-d", "-x", "100", "-y", "30", "sleep 120");
});

afterEach(() => {
  tmux("kill-server");
  rmSync(dir, { recursive: true, force: true });
});

const draai = (extra: Record<string, string>, args: string[] = []) => {
  // de tmux-server is al gestart: de duur gaat via een bestand, niet via de omgeving
  writeFileSync(join(dir, "trust-sec"), extra.TRUST_SECONDEN ?? "0");
  const opdracht = join(dir, "opdracht.md");
  writeFileSync(opdracht, "doe iets\n");
  const r = Bun.spawnSync(["bash", SPAWN, "--naam", "w1", "--opdracht", opdracht, "--lead", "lead-x", "--map", dir, ...args], {
    cwd: dir,
    env: {
      ...schoon(),
      PATH: `${bin}:${process.env.PATH}`,
      TMUX: "",
      TMUX_PANE: "",
      LAB_SPAWN_SCRIPT: join(bin, "nep-agent-spawn.sh"),
      LAB_SPAWN_POLS: "1",
      LAB_SPAWN_WACHT: "5",
      LAB_SPAWN_BEWIJS: "5",
      LAB_LEAD_NAAM: "",
      LAB_LEAD_STAAT: join(dir, "staat"),
      LAB_CLAUDE_JSON: join(dir, "claude.json"),
      ...extra,
    },
  });
  return { code: r.exitCode, uit: r.stdout.toString(), fout: r.stderr.toString() };
};

describe("spawn.sh wacht op de vertrouwensvraag", () => {
  test("wachten, melden, daarna de startzin typen en het ⏺-bewijs zien", () => {
    const r = draai({ TRUST_SECONDEN: "3", WACHT_VERTROUWEN: "20" });
    expect(r.fout).toMatch(/w1 wacht op vertrouwen in pane %\d+ \(map /);
    expect(r.fout.match(/wacht op vertrouwen/g)?.length).toBe(1); // één melding, geen herhaling
    expect(r.code).toBe(0);
    expect(r.uit.trim()).toMatch(/^%\d+$/);
    expect(existsSync(join(dir, "getypt.txt"))).toBe(true);
    expect(readFileSync(join(dir, "getypt.txt"), "utf8")).toContain("Je lead is lead-x. Jij bent sessie w1.");
  });

  test("time-out: fout met pane en startzin, en er is niets getypt", () => {
    const r = draai({ TRUST_SECONDEN: "60", WACHT_VERTROUWEN: "2" });
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/vertrouwensvraag in pane %\d+ niet beantwoord binnen 2s/);
    expect(r.fout).toContain("Je lead is lead-x. Jij bent sessie w1.");
    expect(existsSync(join(dir, "getypt.txt"))).toBe(false);
  });

  test("een niet-vertrouwde map geeft vooraf een waarschuwing; een vertrouwde bovenliggende map niet", () => {
    writeFileSync(join(dir, "claude.json"), JSON.stringify({ projects: { "/elders": { hasTrustDialogAccepted: true } } }));
    const voor = readFileSync(join(dir, "claude.json"), "utf8");
    expect(draai({ TRUST_SECONDEN: "0", WACHT_VERTROUWEN: "5" }).fout).toContain("nog niet vertrouwd");
    expect(readFileSync(join(dir, "claude.json"), "utf8")).toBe(voor); // nooit schrijven
    writeFileSync(join(dir, "claude.json"), JSON.stringify({ projects: { [join(dir, "..")]: { hasTrustDialogAccepted: true } } }));
    rmSync(join(dir, "getypt.txt"), { force: true });
    expect(draai({ TRUST_SECONDEN: "0", WACHT_VERTROUWEN: "5" }).fout).not.toContain("nog niet vertrouwd");
  });

  test("--droog noemt de wachtstap", () => {
    const r = draai({ WACHT_VERTROUWEN: "42" }, ["--droog"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain("vertrouwensvraag");
    expect(r.uit).toContain("42s");
  });
});
