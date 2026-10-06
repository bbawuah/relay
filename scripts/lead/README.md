# Lead-scripts

Twee scripts voor de lead: een sessie starten met een opdrachtbestand, en een PR mergen zonder de voorwaarden te vergeten. Beide kennen `--droog` (laat zien wat er zou gebeuren, doet niets).

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
| `--opdracht <bestand>` | Moet bestaan, anders weigert het script. De sessie krijgt het absolute pad. |
| `--model sonnet\|opus` | Optioneel; zonder de standaard van Claude Code. |
| `--map <pad>` | Werkmap van de sessie; standaard de huidige map. |
| `--lead <naam>` | Naam van de lead voor de startzin; anders env `LAB_LEAD_NAAM`. |
| `--droog` | Alleen tonen. |

Wat het doet:

1. Start `agent-spawn.sh window <map> "claude -n <naam> [--model m]"`. De opdracht staat dus niet in de quotes van het commando.
2. Wacht (max 60 s) tot `tmux capture-pane` "auto mode" of een promptregel (`❯` of `>`) toont.
3. Typt met `tmux send-keys -l` de startzin: "Je lead is <lead>. Jij bent sessie <naam>. Lees <bestand> en voer die uit. Rapporteer aan de lead via SendMessage (to: <lead>)." en daarna Enter.
4. Wacht (max 30 s) op een tool-aanroep (`⏺`) in de pane. Zo niet: exit 1 met melding.
5. Print het pane-id (bijvoorbeeld `%12`) op stdout.

Het script moet binnen tmux draaien (dat eist `agent-spawn.sh`). Voor tests kunnen de wachttijden en het spawn-script worden overschreven: `LAB_SPAWN_SCRIPT`, `LAB_SPAWN_WACHT`, `LAB_SPAWN_POLS`, `LAB_SPAWN_BEWIJS`.

## merge.sh

```sh
scripts/lead/merge.sh 71 --droog   # controleren
scripts/lead/merge.sh 71           # mergen
```

Weigert met exit 1 en een duidelijke reden als:

- de PR niet OPEN is;
- er geen PR-comment is die met "Lead-review: akkoord" begint;
- de verplichte check `poort` ontbreekt of niet groen is (andere checks tellen niet mee);
- `mergeable` niet `MERGEABLE` is, of de tak achterloopt op main (`BEHIND`, de ruleset is strict), of de merge-status DIRTY, BLOCKED, DRAFT of UNKNOWN is.

Zijn de voorwaarden in orde, dan: `gh pr merge <pr> --merge`, daarna controleren dat `state` `MERGED` is, en pas dan `git push origin --delete <tak>`. Staat de PR niet op MERGED, dan blijft de remote tak staan en eindigt het script met exit 1.

Het script gebruikt `gh` en `jq` en pusht vanuit de huidige git-map; draai het vanuit een clone van de repo.

## Tests

```sh
bun test scripts/lead
```

De tests zetten een nep-`gh` en nep-`tmux` vooraan op `PATH` en gebruiken een wegwerp-git-repo met een lokale bare `origin`. Ze raken nooit de echte tmux-server, GitHub of een echte PR.
