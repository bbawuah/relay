# Lead-scripts

Drie scripts voor de lead: een sessie starten met een opdrachtbestand, een PR mergen zonder de voorwaarden te vergeten, en een merge-wachtrij die meerdere goedgekeurde PR's als één integratie-PR door de poort haalt. Alle kennen `--droog` (laat zien wat er zou gebeuren, doet niets).

## spawn.sh

Start `claude` in een nieuw tmux-venster via `~/.claude/tmux/agent-spawn.sh`, wacht tot de sessie invoer aanneemt, typt de vaste startzin en controleert dat de sessie aan het werk gaat.

```sh
scripts/lead/spawn.sh --naam w2 --opdracht ~/vault-b-status/werkwijze-b/CONTRACT.md \
  --model sonnet --map ~/Desktop/LAB-BAWUAH/lab-bawuah/.claude/worktrees/w2 --lead labbawuah-1c
scripts/lead/spawn.sh --naam w2 --opdracht opdracht.md --lead labbawuah-1c --droog
```

| Optie | Betekenis |
|---|---|
| `--naam <n>` | Naam van de sessie (`claude -n <n>`). Alleen letters, cijfers, `.`, `_` en `-`. |
| `--opdracht <bestand>` | Moet bestaan, anders weigert het script. De sessie krijgt het absolute pad (met spatie: tussen enkele quotes). Een pad met regeleinde of `'` wordt geweigerd. |
| `--model sonnet\|opus` | Optioneel; zonder de standaard van Claude Code. |
| `--map <pad>` | Werkmap van de sessie; standaard de huidige map. |
| `--lead <naam>` | Naam van de lead voor de startzin; anders env `LAB_LEAD_NAAM`. |
| `--droog` | Alleen tonen. |

Wat het doet:

1. Start `agent-spawn.sh window <map> "claude -n <naam> [--model m]"`. De opdracht staat dus niet in de quotes van het commando.
2. Wacht (max 60 s) tot `tmux capture-pane` "auto mode" of een lege invoerbox (`│ ❯`) toont. Staat er "trust" of "Do you want" in de pane (trust-dialoog), dan stopt het met exit 1 ("trust-dialoog: Brian moet de map vertrouwen (pane <id>)") en typt niets.
3. Typt met `tmux send-keys -l` de startzin: "Je lead is <lead>. Jij bent sessie <naam>. Lees <bestand> en voer die uit. Rapporteer aan de lead via SendMessage (to: <lead>)." en daarna Enter.
4. Wacht (max 30 s) op een tool-aanroep (`⏺`) in de pane. Zo niet: exit 1 met melding.
5. Print het pane-id (bijvoorbeeld `%12`) op stdout.

Het script moet binnen tmux draaien (dat eist `agent-spawn.sh`). Voor tests kunnen de wachttijden en het spawn-script worden overschreven: `LAB_SPAWN_SCRIPT`, `LAB_SPAWN_WACHT`, `LAB_SPAWN_POLS`, `LAB_SPAWN_BEWIJS` (hele getallen).

## merge.sh

```sh
scripts/lead/merge.sh 71 --droog   # controleren
scripts/lead/merge.sh 71           # mergen
```

Weigert met exit 1 en een duidelijke reden als:

- de PR niet OPEN is;
- de PR uit een fork komt (`isCrossRepository`) of de tak `main`/`master` is;
- er geen PR-comment is die begint met "Lead-review: akkoord <sha7>", met de eerste 7 tekens van de huidige head. Een akkoord van vóór een nieuwe push telt dus niet ("push na akkoord"). Voorbeeld: `Lead-review: akkoord b80ed00`;
- de verplichte check `poort` ontbreekt of niet groen is (de nieuwste run op starttijd telt; andere checks niet);
- `mergeable` niet `MERGEABLE` is, of de tak achterloopt op main (`BEHIND`, de ruleset is strict), of `mergeStateStatus` iets anders is dan CLEAN of UNSTABLE (allowlist). Bij UNSTABLE volgt een waarschuwing.

Zijn de voorwaarden in orde, dan: `gh pr merge <pr> --merge`, daarna controleren dat `state` `MERGED` is, en pas dan `git push origin --delete <tak>`. Staat de PR niet op MERGED, dan blijft de remote tak staan en eindigt het script met exit 1.

### Bezitscheck (optioneel)

```sh
scripts/lead/merge.sh 71 --droog --contract ~/vault-b-status/werkwijze-b/CONTRACT-fase3.md --spoor D2
```

Leest de regel `Bezit: …` in de sectie `## <spoor> ·` van het contract, haalt de paden uit de stukken tussen backticks (een stuk telt als pad als het een `/` of `.` bevat; `scripts/lead/*.test.ts` is een patroon, `docs/` een map, een kaal `merge.sh` telt als bestandsnaam in welke map dan ook) en vergelijkt ze met de bestanden van de PR. Bestanden buiten het Bezit komen als waarschuwing op stderr; het mergen gaat door, de lead beslist. Zonder `--contract` en `--spoor` doet merge.sh niets extra's; één van de twee alleen, een onbekend spoor of een contract zonder paden in de Bezit-regel is een weigering.

Het script gebruikt `gh` en `jq` en pusht vanuit de huidige git-map; draai het vanuit een clone van de repo.

## wachtrij.ts

```sh
bun scripts/lead/wachtrij.ts --droog          # alleen laten zien
bun scripts/lead/wachtrij.ts                  # bouwen, poort draaien, integratie-PR openen
bun scripts/lead/wachtrij.ts --ruim-takken    # na MERGED: remote takken van de onderliggende PR's weg
```

Stappen:

1. Open PR's met een comment die begint met `Lead-review: akkoord <sha7>`, waarbij de sha7 de huidige head is. Forks, concepten en eerdere `wachtrij/`-PR's tellen niet; een verouderd akkoord wordt gemeld.
2. Tak `wachtrij/<jjjjmmdd-hhmm>` in een eigen worktree (naast de repo, `<repo>-wachtrij-<stempel>`) vanaf `origin/main`. De PR's worden in volgorde van nummer samengevoegd met `git merge --no-ff` van de echte head (dus geen squash: GitHub ziet de commits en sluit de onderliggende PR's als gemerged). Een conflict of een tak die na het akkoord is verschoven haalt die PR eruit, met een melding.
3. `bun install && bun run poort` in de worktree: de volledige poort mét e2e. Rood = geen push, geen PR; worktree en tak blijven staan. In het stiltevenster 05:00–07:15 weigert het script (ook `--droog` meldt het).
4. Push en één integratie-PR met het sjabloon: Samenvatting (de lijst), Bewijs (`poort: groen (met e2e) op <sha7>: #n, #m` pas na de geslaagde run, plus de `OK bekijk <app>`-regels uit de onderliggende PR's) en Merge-gevaar (de sectie van de zwaarste onderliggende PR). Een regel `Wachtrij-PR's: <nr>=<tak>=<sha> …` in de body is voor `--ruim-takken`.
5. De lead geeft op de integratie-PR `Lead-review: akkoord <sha7>` en draait `merge.sh <pr>`.
6. `--ruim-takken [<pr>]` (zonder nummer: de laatste gemergede `wachtrij/`-PR): weigert als de PR niet MERGED is, en verwijdert per onderliggende PR de remote tak alleen als de head in `origin/main` staat én de remote tak nog op die sha staat. Standaard worden de takken dus niet verwijderd.

| Optie | Betekenis |
|---|---|
| `--droog` | Alleen tonen; ook bij `--ruim-takken`. |
| `--poort-cmd <cmd>` | Vervangt `bun install && bun run poort` (voor tests). |
| `--nu <jjjjmmdd-hhmm>` | Vaste tijd voor de tak en het stiltevenster (voor tests). |
| `--map <pad>` | Pad van de worktree. |
| `--basis <ref>` | Basis van de wachtrij, standaard `origin/main`. |

## Tests

```sh
bun test scripts/lead
```

De tests zetten een nep-`gh` en nep-`tmux` vooraan op `PATH` en gebruiken een wegwerp-git-repo met een lokale bare `origin`. Ze raken nooit de echte tmux-server, GitHub of een echte PR.
