# Merge-procedure (LAB-BAWUAH-monorepo)

Repo: de hoofdcheckout, GitHub `bbawuah/LAB-BAWUAH`. `main` is beschermd:
PR verplicht, verplichte check `poort` (GitHub Actions), tak moet up-to-date zijn met main (strict, sinds 5 okt), geen force-push, geen bypass.
Pre-push-hook draait `bun run check` (de poort zonder e2e).

## Reviewer die niet plant (vóór elke merge)

Laat een aparte subagent (`model: "sonnet"`, zonder worktree, alleen lezen) de PR beoordelen
voordat je merget. Hij krijgt **alleen**: `gh pr diff <n>`, de regeltabel in `AGENTS.md`, het
`CONTRACT.md` van het spoor of de app, en de PR-body. Niet het plan, niet je gesprek. Prompt:

> Je bent reviewer van PR <n> in de hoofdcheckout. Lees alleen `gh pr diff <n>`,
> `gh pr view <n>`, AGENTS.md (regeltabel) en <pad>/CONTRACT.md. Meld per bevinding: regel of
> contractpunt, bestand:regel, wat er mis is, en of het blokkeert. Ook: bestanden buiten het
> bezit van het spoor, nieuwe "niets"-regels die een check verdienen, workarounds zonder datum.
> Geen stijlpunten. Max 15 regels; "geen bevindingen" mag.

Blokkerend → terug naar de eigenaar. Een bevinding die een rij "niets" in de regeltabel raakt,
noteer je voor de oogst (SKILL.md §9a). Een PR die alleen docs of de vault raakt, mag zonder.

## Eén PR

```bash
cd <hoofdcheckout> && git fetch -q origin
gh pr view <n> --json files,baseRefName,mergeable --jq '...'      # scope controleren
gh pr update-branch <n>                                           # achterstand op main weg
W=../lab-bawuah-poort-<n>
git worktree add -q --detach $W origin/<tak>
(cd $W && bun install --ignore-scripts >/dev/null && bun run poort)
git worktree remove --force $W
gh pr checks <n> --watch --interval 15   # na update-branch: wacht op de NIEUWE run
gh pr comment <n> --body "Lead-review: akkoord … poortuitslag … wie akkoord gaf"
LAB_AGENT_ROL=lead scripts/lead/merge.sh <n>
git pull --ff-only origin main && git push origin --delete <tak>
```

- Lang draaiende poort (e2e ~15 min): op de achtergrond (`run_in_background`) en wachten op de melding.
- `exit`-codes nooit achter een pipe of `;` controleren; dat maskeert een rode stap.
- Gestapelde PR (base is een andere tak): eerst de onderliggende mergen, dan `gh pr edit <n> --base main` en `update-branch`.

## Meerdere PR's tegelijk

Sneller en test ook de combinatie:
1. `git worktree add -b integratie-<x> <pad> origin/main`, daarin `git merge origin/<tak>` per PR.
2. Eén volledige poort op die integratietak (`bun run poort -- --base origin/main`).
3. Groen: per PR `update-branch`, CI afwachten, mergen; gestapelde PR's als laatste.
4. Integratie-worktree en -tak weer weg.

## Wat de poort doet

sherif, boundaries, biome, ds-regels (designnorm), scripts-tests, daarna `turbo` lint,
typecheck, test en build op wat geraakt is, en de e2e van tmux, watchparty en storybook als
die geraakt zijn. Baselines in `scripts/poort-baseline.json` mogen alleen krimpen.
`bun run poort -- --zelftest` bewijst dat elke stap afkeurt. `--alleen <stappen>` voor een
snelle deelcheck.

## Valkuilen die zich hebben voorgedaan

- **Parallelle volledige poorten** van meerdere agents gaven valse rode e2e-runs. Eén tegelijk.
- **Een flaky test was een echte bug** (afronding van ~0,1 µs in de watchparty-regisseur, ~40% van de runs). Laat de oorzaak zoeken.
- **Een poortstap scande ongetrackte bestanden** (bv. `apps/site/.design-sync/`). Alleen `git ls-files`.
- **Worktrees opruimen**: alleen eigen, gemerged én schoon; `git worktree remove` zonder `--force`, zodat git weigert bij onbewaard werk. Onbewaard werk van anderen: eerst als WIP-commit op een eigen tak (`wip/<x>`) zetten en pushen.
- **Vercel bouwt de site bij elke push die de site raakt**; `apps/site/scripts/vercel-ignore.sh` slaat de rest over. Veel losse pushes per PR tellen op (Function Storage).
- **`update-branch` start een nieuwe CI-run**; een wachtlus die de oude groene uitslag ziet, merget te vroeg en de ruleset weigert ("Required status check is expected"). Wacht met `--watch` ná de update.
- **Verificatie van gedrag**: `bun run bekijk <app>` (tmux, watchparty) start de app in een wegwerpomgeving, klikt paden door en levert foto's en console. Draai het zelf bij zichtbare wijzigingen en lees de foto's.
- **Een push naar `main` is productie voor de site** (Vercel). Wat de site zichtbaar raakt: eerst Brians akkoord.
