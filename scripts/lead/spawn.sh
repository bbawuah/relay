#!/usr/bin/env bash
# Start een Claude-sessie in een eigen tmux-venster en geef die een opdracht.
# Gebruik: scripts/lead/spawn.sh --naam <n> --opdracht <bestand> [--model sonnet|opus]
#          [--map <pad>] [--lead <naam>] [--droog]
# Zie scripts/lead/README.md.
set -euo pipefail

SPAWN="${LAB_SPAWN_SCRIPT:-$HOME/.claude/tmux/agent-spawn.sh}"
WACHT="${LAB_SPAWN_WACHT:-60}"     # seconden wachten tot de sessie invoer aanneemt
POLS="${LAB_SPAWN_POLS:-1}"        # seconden tussen twee controles
BEWIJS="${LAB_SPAWN_BEWIJS:-30}"   # seconden wachten op de eerste tool-aanroep

fout() { echo "spawn: $*" >&2; exit 1; }

for v in WACHT POLS BEWIJS; do
  [[ ${!v} =~ ^[0-9]+$ ]] || fout "LAB_SPAWN_$v moet een geheel getal zijn, niet '${!v}'"
done

naam="" opdracht="" model="" map="$PWD" lead="${LAB_LEAD_NAAM:-}" droog=0
waarde() { [ "$#" -ge 2 ] || fout "optie $1 heeft een waarde nodig"; }
while [ $# -gt 0 ]; do
  case $1 in
    --naam) waarde "$@"; naam=$2; shift 2 ;;
    --opdracht) waarde "$@"; opdracht=$2; shift 2 ;;
    --model) waarde "$@"; model=$2; shift 2 ;;
    --map) waarde "$@"; map=$2; shift 2 ;;
    --lead) waarde "$@"; lead=$2; shift 2 ;;
    --droog) droog=1; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) fout "onbekende optie: $1" ;;
  esac
done

[ -n "$naam" ] || fout "--naam ontbreekt"
[[ $naam =~ ^[A-Za-z0-9._-]+$ ]] || fout "naam '$naam' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
[ -n "$opdracht" ] || fout "--opdracht ontbreekt"
case $opdracht in *$'\n'*|*$'\r'*|*"'"*) fout "opdrachtpad mag geen regeleinde of enkele aanhalingsteken bevatten" ;; esac
[ -f "$opdracht" ] || fout "opdrachtbestand bestaat niet: $opdracht"
case $model in ""|sonnet|opus) ;; *) fout "--model moet sonnet of opus zijn, niet '$model'" ;; esac
[ -d "$map" ] || fout "map bestaat niet: $map"
[ -n "$lead" ] || fout "naam van de lead ontbreekt: geef --lead of zet LAB_LEAD_NAAM"
[[ $lead =~ ^[A-Za-z0-9._-]+$ ]] || fout "lead-naam '$lead' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
[ "$droog" = 1 ] || [ -f "$SPAWN" ] || fout "spawn-script niet gevonden: $SPAWN"

opdracht=$(cd "$(dirname "$opdracht")" && pwd)/$(basename "$opdracht")
map=$(cd "$map" && pwd)

cmd="claude -n $naam"
if [ -n "$model" ]; then cmd="$cmd --model $model"; fi
pad=$opdracht
case $pad in *[[:space:]]*) pad="'$pad'" ;; esac
zin="Je lead is $lead. Jij bent sessie $naam. Lees $pad en voer die uit. Rapporteer aan de lead via SendMessage (to: $lead)."

if [ "$droog" = 1 ]; then
  echo "droog: $SPAWN window $map \"$cmd\""
  echo "droog: wacht (max ${WACHT}s) tot de pane 'auto mode' of de promptregel toont"
  echo "droog: tmux send-keys -l \"$zin\" + Enter"
  echo "droog: controleer dat er een tool-aanroep (⏺) verschijnt (max ${BEWIJS}s)"
  exit 0
fi

pane=$(bash "$SPAWN" window "$map" "$cmd" | tail -n 1)
[[ $pane =~ ^%[0-9]+$ ]] || fout "kreeg geen pane-id terug van het spawn-script: '$pane'"

klaar=0 verstreken=0
while :; do
  scherm=$(tmux capture-pane -p -t "$pane" 2>/dev/null || true)
  if printf '%s\n' "$scherm" | grep -Eiq 'trust|do you want'; then
    fout "trust-dialoog: Brian moet de map vertrouwen (pane $pane)"
  fi
  if printf '%s\n' "$scherm" | grep -Eq 'auto mode|^[│ ]*❯ *$'; then klaar=1; break; fi
  [ "$verstreken" -lt "$WACHT" ] || break
  sleep "$POLS"; verstreken=$((verstreken + POLS))
done
[ "$klaar" = 1 ] || fout "sessie $naam (pane $pane) werd niet klaar voor invoer binnen ${WACHT}s; niets getypt"

tmux send-keys -t "$pane" -l "$zin"
tmux send-keys -t "$pane" Enter

verstreken=0
while :; do
  if tmux capture-pane -p -t "$pane" 2>/dev/null | grep -q '⏺'; then
    echo "$pane"; exit 0
  fi
  [ "$verstreken" -lt "$BEWIJS" ] || break
  sleep "$POLS"; verstreken=$((verstreken + POLS))
done
fout "de startzin is getypt in pane $pane, maar er verscheen geen tool-aanroep (⏺) binnen ${BEWIJS}s; kijk zelf in de sessie"
