#!/usr/bin/env bash
# Start een Claude-sessie in een eigen tmux-venster en geef die een opdracht.
# Gebruik: scripts/lead/spawn.sh --naam <n> --opdracht <bestand> [--model sonnet|opus]
#          [--map <pad>] [--lead <unieke naam>] [--sublead [--workflow <JJJJ-MM-DD>]] [--vervolg <tak>] [--droog]
# Zie scripts/lead/README.md.
set -euo pipefail

SPAWN="${LAB_SPAWN_SCRIPT:-$HOME/.claude/tmux/agent-spawn.sh}"
WACHT="${LAB_SPAWN_WACHT:-60}"     # seconden wachten tot de sessie invoer aanneemt
POLS="${LAB_SPAWN_POLS:-1}"        # seconden tussen twee controles
BEWIJS="${LAB_SPAWN_BEWIJS:-30}"   # seconden wachten op de eerste tool-aanroep
WACHT_VERTROUWEN="${WACHT_VERTROUWEN:-600}"  # seconden wachten tot Brian de map vertrouwt
CLAUDE_JSON="${LAB_CLAUDE_JSON:-$HOME/.claude.json}"  # alleen gelezen

fout() { echo "spawn: $*" >&2; exit 1; }

for v in WACHT POLS BEWIJS; do
  [[ ${!v} =~ ^[0-9]+$ ]] || fout "LAB_SPAWN_$v moet een geheel getal zijn, niet '${!v}'"
done
[[ $WACHT_VERTROUWEN =~ ^[0-9]+$ ]] || fout "WACHT_VERTROUWEN moet een geheel getal zijn, niet '$WACHT_VERTROUWEN'"

naam="" opdracht="" model="" map="$PWD" lead="" droog=0 sublead=0 vervolg="" workflow=""
waarde() { [ "$#" -ge 2 ] || fout "optie $1 heeft een waarde nodig"; }
while [ $# -gt 0 ]; do
  case $1 in
    --naam) waarde "$@"; naam=$2; shift 2 ;;
    --opdracht) waarde "$@"; opdracht=$2; shift 2 ;;
    --model) waarde "$@"; model=$2; shift 2 ;;
    --map) waarde "$@"; map=$2; shift 2 ;;
    --lead) waarde "$@"; lead=$2; shift 2 ;;
    --sublead) sublead=1; shift ;;
    --workflow) waarde "$@"; workflow=$2; shift 2 ;;
    --vervolg) waarde "$@"; vervolg=$2; shift 2 ;;
    --droog) droog=1; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) fout "onbekende optie: $1" ;;
  esac
done

# Zonder --lead: de naam van de aanroepende lead uit het register (via TMUX_PANE), anders LAB_LEAD_NAAM.
HIER=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUN="${LAB_LEAD_BUN:-bun}"
if [ -z "$lead" ] && command -v "$BUN" >/dev/null 2>&1; then
  lead=$("$BUN" "$HIER/leadnaam.ts" eigen 2>/dev/null || true)
fi
[ -n "$lead" ] || lead="${LAB_LEAD_NAAM:-}"

[ -n "$naam" ] || fout "--naam ontbreekt"
[[ $naam =~ ^[A-Za-z0-9._-]+$ ]] || fout "naam '$naam' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
[ -n "$opdracht" ] || fout "--opdracht ontbreekt"
case $opdracht in *$'\n'*|*$'\r'*|*"'"*) fout "opdrachtpad mag geen regeleinde of enkele aanhalingsteken bevatten" ;; esac
[ -f "$opdracht" ] || fout "opdrachtbestand bestaat niet: $opdracht"
case $model in ""|sonnet|opus) ;; *) fout "--model moet sonnet of opus zijn, niet '$model'" ;; esac
[ -d "$map" ] || fout "map bestaat niet: $map"
[ -n "$lead" ] || fout "naam van de lead ontbreekt: geef --lead of zet LAB_LEAD_NAAM"
[[ $lead =~ ^[A-Za-z0-9._-]+$ ]] || fout "lead-naam '$lead' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
if command -v "$BUN" >/dev/null 2>&1; then
  # exit 3 = dubbele naam (blokkeert); elke andere fout: waarschuwing en doorgaan (fail-open)
  rc=0
  dubbel=$("$BUN" "$HIER/leadnaam.ts" dubbel "$lead" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 3 ]; then echo "$dubbel" >&2; exit 1; fi
  [ "$rc" = 0 ] || echo "spawn: waarschuwing: controle op dubbele leadnaam mislukt (exit $rc); ga door. $dubbel" >&2
fi
[ -z "$workflow" ] || [ "$sublead" = 1 ] || fout "--workflow hoort bij --sublead"
[ -z "$workflow" ] || [[ $workflow =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fout "--workflow wil de datum van Brians toestemming (JJJJ-MM-DD), niet '$workflow'"
[ "$sublead" = 0 ] || [ -z "$vervolg" ] || fout "--sublead en --vervolg sluiten elkaar uit"
if [ -n "$vervolg" ]; then
  [[ $vervolg =~ ^[A-Za-z0-9._/-]+$ ]] || fout "tak '$vervolg' mag alleen letters, cijfers, punt, streepje, underscore en slash bevatten"
  # GIT_*-variabelen (pre-push-hook) zouden de controle naar een andere repo leiden
  (
    while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep '^GIT_' || true)
    git -C "$map" rev-parse --verify --quiet "refs/heads/$vervolg" >/dev/null ||
      git -C "$map" rev-parse --verify --quiet "refs/remotes/origin/$vervolg" >/dev/null
  ) || fout "tak '$vervolg' bestaat niet (lokaal of op origin) in $map"
fi
[ "$droog" = 1 ] || [ -f "$SPAWN" ] || fout "spawn-script niet gevonden: $SPAWN"

opdracht=$(cd "$(dirname "$opdracht")" && pwd)/$(basename "$opdracht")
map=$(cd "$map" && pwd)

rol=agent
[ "$sublead" = 0 ] || rol=sublead
[ -z "$vervolg" ] || rol=vervolg
# Identiteit voor de hooks (scripts/lead/hooks): de sessie erft deze omgeving.
# Het opdrachtpad kan een spatie bevatten, dus tussen enkele quotes (een ' is al geweigerd).
opdracht_q=$opdracht
case $opdracht_q in *[!A-Za-z0-9_/.:+=@-]*) opdracht_q="'$opdracht_q'" ;; esac
cmd="env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q claude -n $naam"
if [ -n "$model" ]; then cmd="$cmd --model $model"; fi
pad=$opdracht
case $pad in *[[:space:]]*) pad="'$pad'" ;; esac
zin="Je lead is $lead. Jij bent sessie $naam. Lees $pad en voer die uit. Rapporteer aan de lead via SendMessage (to: $lead)."
if [ "$sublead" = 1 ]; then
  zin="Je lead is $lead. Jij bent sessie $naam, sub-lead. Lees $pad en voer die uit volgens scripts/lead/sublead.md: per taak een bouwer, dan een reviewer die niet plant, hooguit één herstelronde, met de Agent-tool."
  if [ -z "$workflow" ]; then
    zin="$zin Geen Workflow-tool."
  else
    zin="$zin Brian gaf op $workflow toestemming voor workflows (zie ~/vault-b-status/lead.md): draai de cyclus als workflow met scripts/lead/vaste-cyclus.js."
  fi
  zin="$zin Rapporteer aan de lead via SendMessage (to: $lead), kort: PR-nummer, sha, reviewoordeel en open punten per taak."
elif [ -n "$vervolg" ]; then
  zin="Je lead is $lead. Jij bent sessie $naam, een vervolgsessie op tak $vervolg. Lees $pad en voer die uit; lees verder alleen git log origin/main..$vervolg en git diff origin/main...$vervolg, geen eerdere sessielogs. Rapporteer aan de lead via SendMessage (to: $lead)."
fi

if [ "$droog" = 1 ]; then
  echo "droog: $SPAWN window $map \"$cmd\""
  echo "droog: tmux set -p -t <pane> @agent_rol $rol; tmux set -p -t <pane> @agent_naam $naam"
  echo "droog: wacht (max ${WACHT}s) tot de pane 'auto mode' of de promptregel toont"
  echo "droog: toont de pane de vertrouwensvraag ('Quick safety check'), dan melding aan Brian (tmux display-message + stderr) en wachten (max ${WACHT_VERTROUWEN}s, WACHT_VERTROUWEN) tot de vraag weg is; nooit zelf antwoorden; bij time-out fout met pane en startzin"
  echo "droog: tmux send-keys -l \"$zin\" + Enter"
  echo "droog: controleer dat er een tool-aanroep (⏺) verschijnt (max ${BEWIJS}s)"
  exit 0
fi

# Waarschuwing vooraf (alleen lezen, nooit schrijven): is de map of een bovenliggende map vertrouwd?
vertrouwd=0 d=$map
if [ -f "$CLAUDE_JSON" ] && command -v jq >/dev/null 2>&1; then
  while :; do
    t=$(jq -r --arg p "$d" '.projects[$p].hasTrustDialogAccepted // false' "$CLAUDE_JSON" 2>/dev/null || echo false)
    if [ "$t" = true ]; then vertrouwd=1; break; fi
    [ "$d" != / ] || break
    d=$(dirname "$d")
  done
else
  vertrouwd=1   # niet te weten: geen waarschuwing
fi
[ "$vertrouwd" = 1 ] || echo "spawn: let op: $map is nog niet vertrouwd in Claude Code; de sessie $naam wacht straks op Brians antwoord op de vertrouwensvraag" >&2

pane=$(bash "$SPAWN" window "$map" "$cmd" | tail -n 1)
[[ $pane =~ ^%[0-9]+$ ]] || fout "kreeg geen pane-id terug van het spawn-script: '$pane'"

tmux set -p -t "$pane" @agent_rol "$rol" 2>/dev/null || true
tmux set -p -t "$pane" @agent_naam "$naam" 2>/dev/null || true

# De echte vertrouwensvraag van Claude Code ("Quick safety check: Is this a project you created or one you trust?"
# met de keuze "Yes, I trust this folder"). Andere vragen tellen niet mee.
VERTROUWEN='Quick safety check|Yes, I trust this folder'

klaar=0 verstreken=0 gemeld=0 start_v=0
while :; do
  scherm=$(tmux capture-pane -p -t "$pane" 2>/dev/null || true)
  # eerst de prompt: de vertrouwenstekst kan na het bevestigen als scrollback boven de prompt blijven staan
  if printf '%s\n' "$scherm" | grep -Eq 'auto mode|^[│ ]*❯ *$'; then klaar=1; break; fi
  if printf '%s\n' "$scherm" | grep -Eq "$VERTROUWEN"; then
    if [ "$gemeld" = 0 ]; then
      gemeld=1 start_v=$SECONDS
      msg="$naam wacht op vertrouwen in pane $pane (map $map)"
      echo "spawn: $msg" >&2
      for c in $(tmux list-clients -F '#{client_name}' 2>/dev/null || true); do
        tmux display-message -c "$c" "$msg" 2>/dev/null || true
      done
    fi
    # Brian beantwoordt de vraag zelf; hier wordt nooit een toets gestuurd.
    if [ $((SECONDS - start_v)) -ge "$WACHT_VERTROUWEN" ]; then
      fout "vertrouwensvraag in pane $pane niet beantwoord binnen ${WACHT_VERTROUWEN}s (map $map); niets getypt. Typ na het vertrouwen met de hand: $zin"
    fi
    sleep "$POLS"
    continue
  fi
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
