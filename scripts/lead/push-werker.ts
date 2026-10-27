#!/usr/bin/env bun
// Pusht het werk van een Codex-werker zonder netwerk (de werker meldt "klaar om te pushen op <sha>").
// Gebruik: LAB_AGENT_ROL=lead scripts/lead/push-werker.sh [--droog] <worktree-van-de-werker> <sha> <tak>
// Alleen voor de lead, vanuit zijn eigen checkout, nooit met de cwd in de worktree van een werker.
// Besluit Brian 27 okt 2026 (#683, optie a): de lead pusht zonder lokale pre-push-poort, want die poort draait `bun run check` in de
// checkout en dat zou ongereviewde werkercode buiten de sandbox uitvoeren. De poort is CI-check `poort`; de lead draait de volledige
// poort vóór de merge, na review.
// Toetst (alles aan de kant van de lead, niets uit de worktree van de werker, want die kan `.git`, `worktrees/<naam>/HEAD|gitdir` en
// `refs/` schrijven): rol lead; <worktree> staat eenduidig in `git worktree list` (vertrouwdeWorktrees); <tak> is niet main/master en is
// de tak die spawn.sh bij de start in <staat>/identiteit/<hash>.json heeft vastgelegd; HEAD van de worktree wijst naar die tak; de tip van
// die tak is <sha>; <sha> is een fast-forward van origin/<tak> (of de tak is nieuw). Elke git-aanroep gaat door `gitHard` (geen hooks,
// geen fsmonitor, geen GIT_*, GIT_NO_REPLACE_OBJECTS=1 zodat refs/replace niets kan vervalsen). Pusht
// `origin <sha>:refs/heads/<tak>`, nooit met --force.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { gitHard, vertrouwdeWorktrees } from "./git-hard.ts";

export type PushUitslag = { code: number; uit: string; fout: string };

export function pushWerker(args: string[], env: Record<string, string | undefined>, cwd: string): PushUitslag {
  const mis = (fout: string): PushUitslag => ({ code: 1, uit: "", fout: `push-werker: ${fout}\n` });
  let droog = false;
  const a = [...args];
  if (a[0] === "--droog") {
    droog = true;
    a.shift();
  }
  if (a.length !== 3) return mis("gebruik: LAB_AGENT_ROL=lead push-werker.sh [--droog] <worktree> <sha> <tak>");
  const [wtArg, sha, tak] = a as [string, string, string];
  if (env.LAB_AGENT_ROL !== "lead") return mis("weigert: alleen de lead (LAB_AGENT_ROL=lead) pusht werkertakken");
  const staat = env.LAB_LEAD_STAAT || path.join(env.HOME ?? "", ".local/state/lab-lead");
  const echt = (p: string) => realpathSync(p);
  const hash = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 24);

  if (!existsSync(wtArg)) return mis(`worktree bestaat niet: ${wtArg}`);
  const wt = echt(wtArg);
  const top = gitHard(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.uit) return mis("niet in een git-checkout");
  const hier = echt(top.uit);

  // Nooit vanuit de worktree van een werker.
  if (hier === wt) return mis(`weigert: dit draait in de worktree van de werker (${wt}). Draai het vanuit je eigen checkout`);
  const hierId = path.join(staat, "identiteit", `${hash(hier)}.json`);
  if (existsSync(hierId)) return mis(`weigert: ${hier} is de worktree van een werker (identiteit ${hierId}). Draai het vanuit je eigen checkout`);

  if (!/^[0-9a-f]{40}$/.test(sha)) return mis(`geef de volledige sha (40 tekens), niet '${sha}'`);
  if (gitHard(hier, ["check-ref-format", "--branch", tak]).code !== 0) return mis(`ongeldige tak: ${tak}`);
  if (["main", "master", "HEAD"].includes(tak) || tak.startsWith("-")) return mis(`weigert: ${tak} is niet toegestaan als doel`);

  // De worktree uit de vertrouwde lijst (gitdir vastgepind aan de kant van de lead).
  const v = vertrouwdeWorktrees(hier).find((x) => x.wt === wt);
  if (!v) return mis(`weigert: ${wt} staat niet (eenduidig) in git worktree list van ${hier}`);

  // De tak die spawn.sh bij de start heeft vastgelegd (de staatmap is niet schrijfbaar voor de werker).
  const idPad = path.join(staat, "identiteit", `${hash(wt)}.json`);
  let vastgelegd = "";
  try {
    vastgelegd = String((JSON.parse(readFileSync(idPad, "utf8")) as { tak?: unknown }).tak ?? "");
  } catch {
    return mis(`weigert: geen identiteit voor ${wt} (${idPad}); deze worktree is niet door spawn.sh gestart of de identiteit is verlopen`);
  }
  if (!vastgelegd) return mis(`weigert: de identiteit van ${wt} legt geen tak vast (gestart zonder tak, of door een oudere spawn.sh)`);
  if (vastgelegd !== tak) return mis(`weigert: spawn legde de tak '${vastgelegd}' vast voor ${wt}, niet '${tak}'`);

  // Tweede laag: HEAD van de worktree wijst nog naar die tak (de werker kan <gitdir>/HEAD herschrijven; het profiel zet hem op read).
  let kop = "";
  try {
    kop = readFileSync(path.join(v.gitdir, "HEAD"), "utf8").trim();
  } catch {
    return mis(`weigert: kon HEAD van ${wt} niet lezen`);
  }
  if (kop !== `ref: refs/heads/${tak}`) return mis(`weigert: HEAD van ${wt} wijst naar '${kop}', niet naar refs/heads/${tak}`);
  const tip = gitHard(hier, ["rev-parse", "--verify", "--quiet", `refs/heads/${tak}^{commit}`]);
  if (tip.code !== 0 || tip.uit !== sha) return mis(`weigert: de tak ${tak} staat op ${tip.uit || "(onbekend)"}, niet op de gemelde ${sha} (de werker is doorgewerkt of de sha klopt niet)`);

  // Fast-forward van de tak op origin (of nieuw).
  const rem = gitHard(hier, ["ls-remote", "--heads", "origin", `refs/heads/${tak}`]);
  if (rem.code !== 0) return mis(`kon origin niet bevragen: ${rem.fout}`);
  const remSha = rem.uit.split(/\s+/)[0] ?? "";
  if (remSha) {
    const f = gitHard(hier, ["fetch", "-q", "origin", `refs/heads/${tak}`]);
    if (f.code !== 0) return mis(`kon origin/${tak} niet ophalen: ${f.fout}`);
    if (gitHard(hier, ["merge-base", "--is-ancestor", remSha, sha]).code !== 0) return mis(`weigert: ${sha} is geen fast-forward van origin/${tak} (${remSha}); geen force-push`);
  }

  const waarschuwing = "push-werker: let op: de lokale pre-push-poort wordt bewust overgeslagen (uitzondering, Brian 27 okt 2026: geen ongereviewde werkercode buiten de sandbox). CI-check 'poort' is de poort; draai de volledige poort vóór de merge.\n";
  if (droog) return { code: 0, uit: `droog: git push origin ${sha}:refs/heads/${tak} (vanuit ${hier})\n`, fout: waarschuwing };
  const p = gitHard(hier, ["push", "origin", `${sha}:refs/heads/${tak}`]);
  return { code: p.code, uit: p.uit ? `${p.uit}\n` : "", fout: waarschuwing + (p.fout ? `${p.fout}\n` : "") };
}

if (import.meta.main) {
  const r = pushWerker(process.argv.slice(2), process.env, process.cwd());
  process.stdout.write(r.uit);
  process.stderr.write(r.fout);
  process.exit(r.code);
}
