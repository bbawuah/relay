// Alleen voor git-hard.test.ts: dezelfde aanroep als gitHard, maar met een optie weggelaten (mutatietest). Hoort niet
// in de productie-API van git-hard.ts; niets in de lead-tooling importeert dit bestand.
import { schoneEnv } from "../test-integriteit.ts";
import { GIT_HARD_OPTIES, type GitOpties, type GitUitslag, IGNORE_VLAG, heeftIgnoreVlag } from "./git-hard.ts";

/** `zonder` noemt de `-c`-waarden (bv. `core.fsmonitor=`) en/of `--ignore-submodules=all` die ontbreken. `gitdirArgv` komt vóór de opties (de pin). */
export function gitHardZonder(cwd: string, args: string[], zonder: string[], opties: GitOpties & { gitdirArgv?: string[] } = {}): GitUitslag {
  const hard: string[] = [];
  for (let i = 0; i < GIT_HARD_OPTIES.length; i += 2) {
    const w = GIT_HARD_OPTIES[i + 1]!;
    if (zonder.includes(w) || (opties.hooks && w.startsWith("core.hooksPath="))) continue;
    hard.push(GIT_HARD_OPTIES[i]!, w);
  }
  const [sub, ...rest] = args;
  const argv = ["git", "-C", cwd, ...(opties.gitdirArgv ?? []), ...hard, sub!, ...(heeftIgnoreVlag(sub!) && !zonder.includes(IGNORE_VLAG) ? [IGNORE_VLAG] : []), ...rest];
  const p = Bun.spawnSync(argv, { env: opties.env ?? schoneEnv(), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, uit: p.stdout.toString().trim(), fout: p.stderr.toString().trim() };
}
