import { describe, expect, test } from "bun:test";
import { CODEX_WERKER_BUN_INSTALL_ARGS, configBlok, spawnCArgs } from "./codex-werker";

const o = {
  worktree: "/werk/wt",
  gitCommon: "/werk/.git",
  gitDir: "/werk/.git/worktrees/wt",
  home: "/thuis/brian",
  tmp: "/tmp",
  naam: "werker-1",
  codexHome: "/thuis/brian/.codex-werker",
  netwerk: false,
};

describe("Codex-werkerprofiel", () => {
  test("spawn -c-waarden zijn byte-gelijk met het bevroren profielcontract", () => {
    const fs = [
      '"/"="read"', '"/werk/wt"="write"', '"/werk/.git/objects"="write"', '"/werk/.git/refs"="write"', '"/werk/.git/logs"="write"',
      '"/werk/.git/worktrees/wt"="write"', '"/werk/.git/worktrees/wt/commondir"="read"', '"/werk/.git/worktrees/wt/gitdir"="read"', '"/werk/.git/worktrees/wt/config.worktree"="read"', '"/werk/.git/worktrees/wt/HEAD"="read"',
      '"/werk/.git/refs/replace"="read"', '"/werk/wt/.git"="read"', '"/tmp/lab-werker-werker-1"="write"', '"/werk/wt/.codex"="read"',
      '"/thuis/brian/.config/klaarover"="none"', '"/thuis/brian/.config/douane"="none"', '"/thuis/brian/.config/agentwerkbank"="none"',
      '"/thuis/brian/.codex-werker"="none"', '"/thuis/brian/.codex-werker/shell_snapshots"="read"', '"/thuis/brian/.codex-werker/skills"="read"', '"/thuis/brian/.codex-werker/prompts"="read"', '"/thuis/brian/.codex-werker/rules"="read"', '"/thuis/brian/.codex-werker/AGENTS.md"="read"', '"/thuis/brian/.codex-werker/packages"="read"',
      '"/thuis/brian/.codex"="none"', '"/thuis/brian/.codex/shell_snapshots"="read"', '"/thuis/brian/.codex/skills"="read"', '"/thuis/brian/.codex/prompts"="read"', '"/thuis/brian/.codex/rules"="read"', '"/thuis/brian/.codex/AGENTS.md"="read"', '"/thuis/brian/.codex/packages"="read"',
      '"/thuis/brian/.ssh"="none"', '"/thuis/brian/.config/gh"="none"', '"/thuis/brian/.netrc"="none"', '"/thuis/brian/.git-credentials"="none"', '"/thuis/brian/.aws"="none"', '"/thuis/brian/.azure"="none"', '"/thuis/brian/.kube"="none"', '"/thuis/brian/.docker"="none"', '"/thuis/brian/.npmrc"="none"', '"/thuis/brian/.config/op"="none"', '"/thuis/brian/Library/Keychains"="none"', '"/thuis/brian/.config/glab-cli"="none"', '"/thuis/brian/.gnupg"="none"', '"/thuis/brian/.config/gcloud"="none"', '"/thuis/brian/Library/Application Support/com.vercel.cli"="none"', '"/thuis/brian/.claude/projects"="none"', '"/thuis/brian/.claude/.credentials.json"="none"', '"/thuis/brian/.claude/history.jsonl"="none"', '"/thuis/brian/.claude.json"="none"',
    ].join(",");
    expect(spawnCArgs(o)).toEqual(['default_permissions="lab-werker"', `permissions.lab-werker.filesystem={${fs}}`, 'permissions.lab-werker.network={enabled=false}']);
  });

  test("netwerk schrijft alleen de bun-cache bij en de installatie blijft zonder scripts", () => {
    const c = spawnCArgs({ ...o, netwerk: true });
    expect(c[1]).toContain('"/thuis/brian/.bun/install/cache"="write"');
    expect(c).toEqual([
      'default_permissions="lab-werker"',
      spawnCArgs(o)[1]!.replace(',"/werk/wt/.codex"', ',"/thuis/brian/.bun/install/cache"="write","/werk/wt/.codex"'),
      'permissions.lab-werker.network={enabled=true}',
    ]);
    expect(CODEX_WERKER_BUN_INSTALL_ARGS).toEqual(["install", "--ignore-scripts", "--frozen-lockfile"]);
  });

  test("eigen CODEX_HOME-profiel parseert en heeft dezelfde denylist met netwerk uit", () => {
    const blok = configBlok({ home: o.home, codexHome: o.codexHome });
    const t = Bun.TOML.parse(blok) as { default_permissions?: string; permissions?: { "lab-werker"?: { filesystem?: Record<string, string>; network?: { enabled?: boolean } } } };
    const p = t.permissions?.["lab-werker"];
    expect(t.default_permissions).toBe("lab-werker");
    expect(p?.network?.enabled).toBe(false);
    expect(p?.filesystem?.["/thuis/brian/.ssh"]).toBe("none");
    expect(p?.filesystem?.["/thuis/brian/.config/gh"]).toBe("none");
    expect(p?.filesystem?.["/thuis/brian/Library/Keychains"]).toBe("none");
    expect(p?.filesystem?.["/thuis/brian/.codex-werker"]).toBe("none");
    expect(p?.filesystem?.["/thuis/brian/.codex-werker/packages"]).toBe("read");
  });
});
