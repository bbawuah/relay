#!/usr/bin/env bash
# Start een Claude-sessie in een eigen tmux-venster en geef die een opdracht.
# Gebruik: scripts/lead/spawn.sh --naam <n> --opdracht <bestand> [--model sonnet|opus]
#          [--map <pad>] [--lead <unieke naam>] [--sublead [--workflow <JJJJ-MM-DD>]] [--vervolg <tak>] [--t3] [--droog]
#          --t3: start de sessie als thread in T3 Code (server op deze machine) in plaats van in tmux; --map moet dan
#          een eigen worktree zijn. Laatste regel van de uitvoer: t3:<thread-id>.
#        scripts/lead/spawn.sh --meerdere <lijst> [--model ..] [--map ..] [--lead ..] [--droog]
#          lijst: per regel `naam opdrachtbestand [sonnet|opus]` (# en lege regels worden overgeslagen). Alle sessies
#          starten parallel; per sessie dezelfde controles als hierboven; het eindoordeel is luid: exit 1 en een regel
#          per mislukte sessie als er één niet startte of zijn startregel niet aankwam.
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

naam="" opdracht="" model="" map="$PWD" lead="" droog=0 sublead=0 vervolg="" workflow="" meerdere="" t3=0
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
    --meerdere) waarde "$@"; meerdere=$2; shift 2 ;;
    --t3) t3=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) fout "onbekende optie: $1" ;;
  esac
done

if [ -n "$meerdere" ]; then
  [ -z "$naam$opdracht$vervolg" ] && [ "$sublead" = 0 ] || fout "--meerdere sluit --naam, --opdracht, --vervolg en --sublead uit"
  [ -f "$meerdere" ] || fout "lijst bestaat niet: $meerdere"
  zelf="${BASH_SOURCE[0]}"
  # Eerst de hele lijst valideren, dan pas starten: een kapotte regel halverwege laat geen halve reeks of temp-map achter.
  namen=() opdrachten=() modellen=()
  regelnr=0
  while read -r n o m extra; do
    regelnr=$((regelnr + 1))
    case ${n:-} in ""|"#"*) continue ;; esac
    [ -n "${o:-}" ] && [ -z "${extra:-}" ] || fout "$meerdere regel $regelnr: verwacht 'naam opdrachtbestand [model]'"
    [[ $n =~ ^[A-Za-z0-9._-]+$ ]] || fout "$meerdere regel $regelnr: naam '$n' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
    for eerder in ${namen[@]+"${namen[@]}"}; do
      [ "$eerder" != "$n" ] || fout "$meerdere regel $regelnr: dubbele naam '$n'; er is nog niets gestart"
    done
    [ -f "$o" ] || fout "$meerdere regel $regelnr: opdrachtbestand bestaat niet: $o; er is nog niets gestart"
    case ${m:-$model} in ""|sonnet|opus) ;; *) fout "$meerdere regel $regelnr: model moet sonnet of opus zijn, niet '${m:-$model}'" ;; esac
    namen+=("$n") opdrachten+=("$o") modellen+=("${m:-$model}")
  done <"$meerdere"
  [ "${#namen[@]}" -gt 0 ] || fout "lijst $meerdere bevat geen sessies"
  uitmap=$(mktemp -d "${TMPDIR:-/tmp}/spawn-meerdere.XXXXXX")
  pids=()
  for i in "${!namen[@]}"; do
    args=(--naam "${namen[$i]}" --opdracht "${opdrachten[$i]}" --map "$map")
    [ -z "${modellen[$i]}" ] || args+=(--model "${modellen[$i]}")
    [ -z "$lead" ] || args+=(--lead "$lead")
    [ "$droog" = 0 ] || args+=(--droog)
    [ "$t3" = 0 ] || args+=(--t3)
    bash "$zelf" "${args[@]}" >"$uitmap/${namen[$i]}.uit" 2>"$uitmap/${namen[$i]}.fout" &
    pids+=($!)
  done
  mislukt=0
  for i in "${!namen[@]}"; do
    n=${namen[$i]} rc=0
    wait "${pids[$i]}" || rc=$?
    if [ "$rc" = 0 ]; then
      echo "spawn: $n gestart: $(tail -n 1 "$uitmap/$n.uit")"
    else
      mislukt=$((mislukt + 1))
      echo "spawn: MISLUKT $n (exit $rc): $(cat "$uitmap/$n.fout")" >&2
    fi
  done
  rm -rf "$uitmap"
  [ "$mislukt" = 0 ] || fout "$mislukt van ${#namen[@]} sessies zijn niet (goed) gestart; zie de regels hierboven"
  exit 0
fi

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
[ "$droog" = 1 ] || [ "$t3" = 1 ] || [ -f "$SPAWN" ] || fout "spawn-script niet gevonden: $SPAWN"

opdracht=$(cd "$(dirname "$opdracht")" && pwd)/$(basename "$opdracht")
map=$(cd "$map" && pwd)

# --- T3 Code ---------------------------------------------------------------------------------------------------
# T3 kent geen omgeving per thread (alleen per provider-instantie), dus de identiteit voor de hooks gaat in
# <map>/.claude/settings.local.json (git-genegeerd), die de Claude-provider van T3 per checkout inleest. Eén
# identiteit per checkout: daarom alleen een eigen worktree, nooit de hoofdcheckout of een map van een andere sessie.
git_schoon() (
  # GIT_*-variabelen (pre-push-hook) zouden git naar een andere repo leiden
  while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep '^GIT_' || true)
  git "$@"
)

t3_bin() {
  if [ -n "${LAB_T3:-}" ]; then echo "$LAB_T3"; return; fi
  command -v t3 2>/dev/null && return
  # de desktop-app installeert de server buiten PATH
  ls -d "$HOME"/.t3/runtime/versions/*/t3 2>/dev/null | sort -V | tail -n 1
}

t3_controleer_map() {
  command -v jq >/dev/null 2>&1 || fout "--t3 heeft jq nodig"
  local top gemeen eigen inst bestaand
  top=$(git_schoon -C "$map" rev-parse --show-toplevel 2>/dev/null) || fout "--t3: $map is geen git-checkout"
  [ "$(cd "$top" && pwd -P)" = "$(cd "$map" && pwd -P)" ] || fout "--t3: --map moet de wortel van een worktree zijn ($top), geen submap"
  gemeen=$(cd "$map" && cd "$(git_schoon rev-parse --git-common-dir)" && pwd -P)
  eigen=$(cd "$(git_schoon -C "$map" rev-parse --absolute-git-dir)" && pwd -P)
  [ "$eigen" != "$gemeen" ] || fout "--t3: $map is de hoofdcheckout; maak een eigen worktree (git worktree add) en geef die als --map"
  git_schoon -C "$map" check-ignore -q .claude/settings.local.json ||
    fout "--t3: .claude/settings.local.json is niet git-genegeerd in $map; de identiteit zou dan in een commit kunnen belanden"
  inst="$map/.claude/settings.local.json"
  if [ -f "$inst" ]; then
    jq -e 'type == "object"' "$inst" >/dev/null 2>&1 || fout "--t3: $inst is geen JSON-object; niets aangeraakt"
    bestaand=$(jq -r '.env.LAB_AGENT_NAAM // ""' "$inst")
    [ -z "$bestaand" ] || [ "$bestaand" = "$naam" ] ||
      fout "--t3: $map draagt al de identiteit van sessie '$bestaand' (env in $inst); één T3-sessie per checkout. Is die klaar, haal dan de LAB_*-sleutels uit env weg"
  fi
  return 0
}

t3_start() {
  local zin=$1 bin model_slug provider inst tmp uit id verstreken js st items pend
  t3_controleer_map
  bin=$(t3_bin || true)
  provider="${LAB_T3_PROVIDER:-claudeAgent}"
  case $model in
    sonnet) model_slug=claude-sonnet-5-5 ;;
    opus) model_slug=claude-opus-5-5 ;;
    *) model_slug="${LAB_T3_MODEL:-claude-opus-5-5}" ;;
  esac
  inst="$map/.claude/settings.local.json"
  if [ "$droog" = 1 ]; then
    echo "droog: zet env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q LAB_SPAWN_ID=$spawn_id in $inst (overige sleutels blijven)"
    echo "droog: ${bin:-t3} project add --title $naam $map (alleen als de map nog geen T3-project is)"
    echo "droog: ${bin:-t3} thread start --title $naam --provider $provider --model $model_slug $map - (startzin op stdin)"
    echo "droog: startzin: $zin"
    echo "droog: controleer met thread show dat de thread aan het werk is (max ${BEWIJS}s); laatste regel t3:<thread-id>"
    exit 0
  fi
  [ -n "$bin" ] && [ -x "$bin" ] || fout "--t3: t3 niet gevonden (zet LAB_T3, of verbind T3 Code eenmaal met deze machine zodat ~/.t3/runtime bestaat)"

  mkdir -p "$map/.claude"
  [ -f "$inst" ] || echo '{}' >"$inst"
  tmp=$(mktemp "$inst.XXXXXX")
  jq --arg n "$naam" --arg r "$rol" --arg l "$lead" --arg o "$opdracht" --arg s "$spawn_id" \
    '.env = ((.env // {}) + {LAB_AGENT_NAAM: $n, LAB_AGENT_ROL: $r, LAB_LEAD_NAAM: $l, LAB_OPDRACHT: $o, LAB_SPAWN_ID: $s})' \
    "$inst" >"$tmp" || { rm -f "$tmp"; fout "--t3: kon $inst niet bijwerken"; }
  mv "$tmp" "$inst"

  if ! (cd "$map" && "$bin" thread list >/dev/null 2>&1); then
    uit=$("$bin" project add --title "$naam" "$map" 2>&1) || fout "--t3: project toevoegen mislukte (draait de T3-server?): $uit"
  fi
  uit=$(printf '%s\n' "$zin" | "$bin" thread start --title "$naam" --provider "$provider" --model "$model_slug" "$map" - 2>&1) ||
    fout "--t3: thread starten mislukte: $uit"
  # t3 drukt het id af (in een terminal met "Thread " ervoor): de laatste niet-lege regel
  id=$(printf '%s\n' "$uit" | sed -e 's/^Thread //' -e '/^[[:space:]]*$/d' | tail -n 1)
  [[ $id =~ ^[A-Za-z0-9:._%-]+$ ]] || fout "--t3: geen thread-id in de uitvoer van t3: $uit"

  # Bewijs dat de sessie werkt (zoals ⏺ in tmux): item 1 is de startzin, item 2 een hook die direct meedraait
  # (binnen milliseconden, vermoedelijk een hook; gezien met T3 0.1.2), pas item 3 is werk van de agent zelf.
  verstreken=0
  while :; do
    js=$("$bin" thread show "$id" --json 2>/dev/null || true)
    st=$(printf '%s' "$js" | jq -r '.thread.status // ""' 2>/dev/null || true)
    items=$(printf '%s' "$js" | jq -r '.thread.itemCount // 0' 2>/dev/null || echo 0)
    pend=$(printf '%s' "$js" | jq -r '.thread.pendingRequestCount // 0' 2>/dev/null || echo 0)
    case $st in failed|error|interrupted|cancelled) fout "--t3: thread $id staat op '$st'; kijk in T3 Code" ;; esac
    if [[ $items =~ ^[0-9]+$ ]] && [ "$items" -ge 3 ]; then
      [ "$pend" = 0 ] || echo "spawn: let op: thread $id wacht op een antwoord in T3 Code; stuur geen t3 thread send zolang pendingRequestCount > 0" >&2
      echo "t3:$id"; exit 0
    fi
    [ "$verstreken" -lt "$BEWIJS" ] || break
    sleep "$POLS"; verstreken=$((verstreken + POLS))
  done
  fout "--t3: thread $id is gestart, maar toonde geen werk binnen ${BEWIJS}s; kijk zelf in T3 Code"
}

rol=agent
[ "$sublead" = 0 ] || rol=sublead
[ -z "$vervolg" ] || rol=vervolg
# Identiteit voor de hooks (scripts/lead/hooks): de sessie erft deze omgeving.
# Het opdrachtpad kan een spatie bevatten, dus tussen enkele quotes (een ' is al geweigerd).
opdracht_q=$opdracht
case $opdracht_q in *[!A-Za-z0-9_/.:+=@-]*) opdracht_q="'$opdracht_q'" ;; esac
# Eenmalig id: een kindproces dat deze omgeving erft (claude -p) herkent de hook er aan dat het geen eigen sessie is.
spawn_id="$(date +%s)-$$-$RANDOM"
cmd="env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q LAB_SPAWN_ID=$spawn_id claude -n $naam"
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

zin="$zin Sluit je laatste rapport aan de lead af met een vaste slotregel (laatste regel, kaal): \`vrij\` als je klaar en opgeruimd bent, of \`wacht op achtergrondrun tot ~HH:MM\` (hoogstens 2 uur vooruit) als je op een achtergrondrun wacht. \"vrij\" ergens anders in de tekst telt niet."

if [ "$t3" = 1 ]; then
  zin="$zin Je draait als thread in T3 Code: gebruik geen AskUserQuestion (de lead ziet die vraag niet en een bericht van de lead laat hem vastlopen), maar zet een vraag in tekst in je rapport. Zet je laatste rapport ook als je laatste antwoord in deze thread."
  t3_start "$zin"   # eindigt altijd met exit
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
