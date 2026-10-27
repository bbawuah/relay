// Git in de lead-tooling, gehard voor mappen die van een werker kunnen zijn (een werker-worktree, een wachtrij-worktree
// met samengevoegde PR-inhoud). Een werker kan in zijn worktree een `sub/.git` met `gitdir:` naar een eigen map aanmaken,
// met een config met `core.fsmonitor` of `filter.*.clean`, plus een gitlink in de index: een gewone `git status` of
// `git diff` BUITEN de sandbox voert dat commando dan uit als Brian of de lead. Een relatief `core.hooksPath` (`.githooks`)
// laat een commit, merge of push van iemand anders in die worktree ook de hooks van de werker draaien. Daarom gaat elke
// git-aanroep in zulke mappen hierdoor. Kan de werker `wt/.git` herschrijven, dan helpt dat alles niet: daarom pint
// `gitInWorktree` de gitdir via een vertrouwde `git worktree list` in de repo van de lead.
// Regel in AGENTS.md; afgedwongen door git-hard.test.ts (markeerbestanden, mutatietests en een bronscan).

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { schoneEnv } from "../test-integriteit.ts";

/** Opties die elke geharde aanroep meekrijgt (vóór het subcommando). */
export const GIT_HARD_OPTIES = [
  "-c", "core.fsmonitor=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.untrackedCache=false",
  "-c", "diff.ignoreSubmodules=all",
];

/**
 * Plumbing leest `diff.ignoreSubmodules` niet; die krijgt de vlag zelf. Porcelain `diff` ook: een `.gitmodules` van de werker met
 * `ignore=none` gaat boven de config-sleutel, alleen de vlag op de opdrachtregel gaat daar weer boven.
 */
const MET_IGNORE = new Set(["status", "diff", "diff-index", "diff-files", "diff-tree"]);
export const IGNORE_VLAG = "--ignore-submodules=all";
export const heeftIgnoreVlag = (sub: string): boolean => MET_IGNORE.has(sub);

/**
 * Wat de helper niet draait: `stash` en `describe --dirty` kijken in submodules zonder dat de vlag of de config-sleutel dat
 * tegenhoudt (een `.gitmodules` met `ignore=none` wint), dus het clean-filter van de werker zou draaien. Geeft de reden, of null.
 */
export function geweigerdeAanroep(args: string[]): string | null {
  const sub = args[0];
  if (sub === "stash") return "git stash wordt niet gehard (kijkt in submodules); doe het niet in een map van een werker";
  if (sub === "describe" && args.some((a) => a === "--dirty" || a.startsWith("--dirty="))) return "git describe --dirty wordt niet gehard (kijkt in submodules)";
  return null;
}

export type GitUitslag = { code: number; uit: string; fout: string };
export type GitOpties = {
  /** Omgeving van het kind; standaard `schoneEnv()` (zonder GIT_*). Een eigen omgeving moet zelf zonder GIT_* zijn. */
  env?: Record<string, string>;
  /** Laat de hooks van de repo draaien (alleen `push` in een door de tooling zelf gemaakte worktree, waar de pre-push-poort bewust draait). */
  hooks?: boolean;
};

/** De argv voor `git`: opties, dan het subcommando (met `--ignore-submodules=all` waar dat past). `args[0]` is het subcommando. */
export function gitArgs(args: string[], opties: GitOpties = {}): string[] {
  const hard: string[] = [];
  for (let i = 0; i < GIT_HARD_OPTIES.length; i += 2) {
    if (opties.hooks && GIT_HARD_OPTIES[i + 1]!.startsWith("core.hooksPath=")) continue;
    hard.push(GIT_HARD_OPTIES[i]!, GIT_HARD_OPTIES[i + 1]!);
  }
  const [sub, ...rest] = args;
  return [...hard, sub!, ...(heeftIgnoreVlag(sub!) ? [IGNORE_VLAG] : []), ...rest];
}

function draai(argv: string[], opties: GitOpties): GitUitslag {
  // GIT_NO_REPLACE_OBJECTS: een werker kan `refs/replace/<sha>` schrijven (gedeelde refs/); zonder dit liegen merge-base, log en diff
  // over wat een commit is. Dit geldt voor elke aanroep van de helper.
  const p = Bun.spawnSync(["git", ...argv], { env: { ...(opties.env ?? schoneEnv()), GIT_NO_REPLACE_OBJECTS: "1" }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, uit: p.stdout.toString().trim(), fout: p.stderr.toString().trim() };
}

/** Draait `git -C <cwd> <args>` gehard. `cwd` mag ontbreken (dan de huidige map). Gooit niet. Voor mappen die NIET van een werker zijn (de repo van de lead zelf). */
export function gitHard(cwd: string | undefined, args: string[], opties: GitOpties = {}): GitUitslag {
  const nee = geweigerdeAanroep(args);
  if (nee) return { code: 126, uit: "", fout: `geweigerd: ${nee}` };
  return draai([...(cwd ? ["-C", cwd] : []), ...gitArgs(args, opties)], opties);
}

export type Vertrouwd = { wt: string; gitdir: string; common: string };

const echt = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * De worktrees van de repo van de lead, met hun gitdir, uit `git worktree list --porcelain` en de `gitdir`-bestanden in
 * `<common>/worktrees/*` (alles aan de kant van de lead, niet uit `wt/.git`). `root` is de eigen repo van de lead.
 * Een worktree telt alleen mee als: zijn pad gelijk is aan zijn realpath (geen symlink), dat pad maar één keer voorkomt (in de
 * lijst én onder de gitdir-bestanden: een werker kan `<common>/worktrees/<n>/gitdir` herschrijven naar het pad van een ander) en
 * `<gitdir>/gitdir` precies terugwijst naar `<wt>/.git`.
 */
export function vertrouwdeWorktrees(root: string, opties: GitOpties = {}): Vertrouwd[] {
  const c = gitHard(root, ["rev-parse", "--git-common-dir"], opties);
  if (c.code !== 0 || !c.uit) return [];
  const common = echt(path.resolve(root, c.uit));
  const l = gitHard(root, ["worktree", "list", "--porcelain"], opties);
  if (l.code !== 0) return [];
  const paden = l.uit.split("\n").filter((r) => r.startsWith("worktree ")).map((r) => r.slice("worktree ".length));
  const telLijst = new Map<string, number>();
  for (const r of paden) telLijst.set(echt(r), (telLijst.get(echt(r)) ?? 0) + 1);
  const gitdirs = new Map<string, { gitdir: string; doel: string }[]>();
  const wmap = path.join(common, "worktrees");
  if (existsSync(wmap)) {
    for (const naam of readdirSync(wmap)) {
      try {
        const doel = readFileSync(path.join(wmap, naam, "gitdir"), "utf8").trim(); // <wt>/.git
        const sleutel = echt(path.dirname(doel));
        gitdirs.set(sleutel, [...(gitdirs.get(sleutel) ?? []), { gitdir: path.join(wmap, naam), doel }]);
      } catch {
        // geen gitdir-bestand: niet vertrouwd
      }
    }
  }
  return paden.flatMap((wt) => {
    const echtPad = echt(wt);
    if (wt !== echtPad || telLijst.get(echtPad) !== 1) return [];
    if (wt === path.dirname(common)) return gitdirs.has(echtPad) ? [] : [{ wt, gitdir: common, common }];
    const g = gitdirs.get(echtPad);
    if (!g || g.length !== 1 || g[0]!.doel !== path.join(wt, ".git")) return [];
    return [{ wt, gitdir: g[0]!.gitdir, common }];
  });
}

/**
 * Draait git in een worktree die van een werker kan zijn, met de gitdir vastgepind: `--git-dir=<gitdir> --work-tree=<wt>`,
 * zodat `wt/.git` (dat een werker kan herschrijven) niet meer gelezen wordt. Weigert (code 126) een pad dat niet in de
 * vertrouwde lijst van `root` staat, of waarvan `rev-parse --git-common-dir` niet de repo van `root` is. Gooit niet.
 */
export function gitInWorktree(root: string, wt: string, args: string[], opties: GitOpties = {}): GitUitslag {
  const weiger = (fout: string): GitUitslag => ({ code: 126, uit: "", fout: `geweigerd: ${fout}` });
  const nee = geweigerdeAanroep(args);
  if (nee) return weiger(nee);
  const pad = echt(wt);
  const v = vertrouwdeWorktrees(root, opties).find((x) => x.wt === pad);
  if (!v) return weiger(`${wt} staat niet (eenduidig) in git worktree list van ${root}`);
  // extensions.worktreeConfig laat <gitdir>/config.worktree meetellen, en die kan de werker schrijven
  const wc = gitHard(root, ["config", "--type=bool", "--get", "extensions.worktreeConfig"], opties);
  if (wc.uit === "true" && existsSync(path.join(v.gitdir, "config.worktree"))) return weiger(`extensions.worktreeConfig staat aan en ${path.join(v.gitdir, "config.worktree")} bestaat`);
  const vast = ["-C", v.wt, `--git-dir=${v.gitdir}`, `--work-tree=${v.wt}`];
  const gemeen = draai([...vast, ...gitArgs(["rev-parse", "--git-common-dir"])], opties);
  if (gemeen.code !== 0 || echt(path.resolve(v.gitdir, gemeen.uit)) !== v.common) return weiger(`${wt} hoort niet bij de repo ${v.common}`);
  return draai([...vast, ...gitArgs(args, opties)], opties);
}
