// Git in de lead-tooling, gehard voor mappen die van een werker kunnen zijn (een werker-worktree, een wachtrij-worktree
// met samengevoegde PR-inhoud). Een werker kan in zijn worktree een `sub/.git` met `gitdir:` naar een eigen map aanmaken,
// met een config met `core.fsmonitor`, plus een gitlink in de index: een gewone `git status` BUITEN de sandbox voert dat
// commando dan uit als Brian of de lead. Een relatief `core.hooksPath` (`.githooks`) laat een commit, merge of push van
// iemand anders in die worktree ook de hooks van de werker draaien. Daarom gaat elke git-aanroep in zulke mappen hierdoor.
// Regel in AGENTS.md; afgedwongen door git-hard.test.ts (markeerbestanden, mutatietest en een bronscan).

import { schoneEnv } from "../test-integriteit.ts";

/** Opties die elke geharde aanroep meekrijgt (vóór het subcommando). */
export const GIT_HARD_OPTIES = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false"];

export type GitUitslag = { code: number; uit: string; fout: string };
export type GitOpties = {
  /** Omgeving van het kind; standaard `schoneEnv()` (zonder GIT_*). Een eigen omgeving moet zelf zonder GIT_* zijn. */
  env?: Record<string, string>;
  /** Laat de hooks van de repo draaien (alleen `push` in een door de tooling zelf gemaakte worktree, waar de pre-push-poort bewust draait). */
  hooks?: boolean;
};

/** De argv voor `git`: opties, dan het subcommando; bij `status` ook `--ignore-submodules=all`. `args[0]` is het subcommando. */
export function gitArgs(args: string[], opties: GitOpties & { zonder?: string[] } = {}): string[] {
  const hard: string[] = [];
  for (let i = 0; i < GIT_HARD_OPTIES.length; i += 2) {
    const waarde = GIT_HARD_OPTIES[i + 1]!;
    if (opties.hooks && waarde.startsWith("core.hooksPath=")) continue;
    if (opties.zonder?.includes(waarde)) continue;
    hard.push(GIT_HARD_OPTIES[i]!, waarde);
  }
  const [sub, ...rest] = args;
  return [...hard, sub!, ...(sub === "status" && !opties.zonder?.includes("--ignore-submodules=all") ? ["--ignore-submodules=all"] : []), ...rest];
}

/** Draait `git -C <cwd> <args>` gehard. `cwd` mag ontbreken (dan de huidige map). Gooit niet. */
export function gitHard(cwd: string | undefined, args: string[], opties: GitOpties & { zonder?: string[] } = {}): GitUitslag {
  const argv = ["git", ...(cwd ? ["-C", cwd] : []), ...gitArgs(args, opties)];
  const p = Bun.spawnSync(argv, { env: opties.env ?? schoneEnv(), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, uit: p.stdout.toString().trim(), fout: p.stderr.toString().trim() };
}
