#!/usr/bin/env bash
# Start een Claude-sessie in een eigen tmux-venster en geef die een opdracht.
# Gebruik: scripts/lead/spawn.sh --naam <n> --opdracht <bestand> [--model sonnet|opus]
#          [--map <pad>] [--lead <unieke naam>] [--sublead [--workflow <JJJJ-MM-DD>]] [--vervolg <tak>] [--t3] [--droog]
#          [--vendor claude|codex] [--netwerk]
#          --vendor codex: een Codex-sessie (`codex -C <map>`; --model is dan een Codex-model); standaard claude. Eist een eigen
#          eigen worktree voor checkout-identiteit; het bestaande vendorprofiel blijft gelden.
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
ENTER="${LAB_SPAWN_ENTER:-1}"      # seconden tussen de startzin en Enter bij Codex (snel typen + Enter telt als plakken: Enter wordt dan een nieuwe regel)
WACHT_VERTROUWEN="${WACHT_VERTROUWEN:-600}"  # seconden wachten tot Brian de map vertrouwt
CLAUDE_JSON="${LAB_CLAUDE_JSON:-$HOME/.claude.json}"  # alleen gelezen

fout() { echo "spawn: $*" >&2; exit 1; }
# Een identiteitsbestand dat deze aanroep schreef, maar waarvan de sessie niet startte, mag niet blijven staan
# (anders blokkeert het de volgende spawn in die checkout en krijgt een latere sessie de rol).
ID_GESCHREVEN=""
fout_ruim() { [ -z "$ID_GESCHREVEN" ] || rm -f "$ID_GESCHREVEN"; fout "$@"; }

for v in WACHT POLS BEWIJS ENTER; do
  [[ ${!v} =~ ^[0-9]+$ ]] || fout "LAB_SPAWN_$v moet een geheel getal zijn, niet '${!v}'"
done
[[ $WACHT_VERTROUWEN =~ ^[0-9]+$ ]] || fout "WACHT_VERTROUWEN moet een geheel getal zijn, niet '$WACHT_VERTROUWEN'"

naam="" opdracht="" model="" map="$PWD" lead="" droog=0 sublead=0 vervolg="" workflow="" meerdere="" t3=0 vendor=claude netwerk=0
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
    --netwerk) netwerk=1; shift ;;
    --vendor) waarde "$@"; vendor=$2; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) fout "onbekende optie: $1" ;;
  esac
done

case $vendor in claude|codex) ;; *) fout "--vendor moet claude of codex zijn, niet '$vendor'" ;; esac
[ "$netwerk" = 0 ] || [ "$vendor" = codex ] || fout "--netwerk hoort bij --vendor codex"

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
    [[ $n =~ ^[Cc][Oo][Dd][Ee][Xx]-[0-9A-Fa-f]{12}$ ]] && fout "$meerdere regel $regelnr: naam '$n' is gereserveerd (afgeleide namen van Codex-sessies zonder identiteit)"
    for eerder in ${namen[@]+"${namen[@]}"}; do
      [ "$eerder" != "$n" ] || fout "$meerdere regel $regelnr: dubbele naam '$n'; er is nog niets gestart"
    done
    [ -f "$o" ] || fout "$meerdere regel $regelnr: opdrachtbestand bestaat niet: $o; er is nog niets gestart"
    if [ "$vendor" = codex ]; then
      [[ ${m:-$model} =~ ^[A-Za-z0-9._-]*$ ]] || fout "$meerdere regel $regelnr: codex-model '${m:-$model}' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
    else
      case ${m:-$model} in ""|sonnet|opus) ;; *) fout "$meerdere regel $regelnr: model moet sonnet of opus zijn, niet '${m:-$model}'" ;; esac
    fi
    namen+=("$n") opdrachten+=("$o") modellen+=("${m:-$model}")
  done <"$meerdere"
  [ "${#namen[@]}" -gt 0 ] || fout "lijst $meerdere bevat geen sessies"
  # Zonder netwerk installeert elke sessie in dezelfde --map: parallel `bun install` in één worktree botst (en één Codex-sessie per checkout).
  if [ "$vendor" = codex ] && [ "$netwerk" = 0 ] && [ "$droog" = 0 ] && [ "$t3" = 0 ] && [ "${#namen[@]}" -gt 1 ]; then
    fout "--meerdere met --vendor codex en meer dan één sessie weigert zonder --netwerk: de installatie zou parallel in één worktree draaien. Start de sessies apart"
  fi
  uitmap=$(mktemp -d "${TMPDIR:-/tmp}/spawn-meerdere.XXXXXX")
  pids=()
  for i in "${!namen[@]}"; do
    args=(--naam "${namen[$i]}" --opdracht "${opdrachten[$i]}" --map "$map")
    [ -z "${modellen[$i]}" ] || args+=(--model "${modellen[$i]}")
    [ -z "$lead" ] || args+=(--lead "$lead")
    [ "$droog" = 0 ] || args+=(--droog)
    [ "$t3" = 0 ] || args+=(--t3)
    [ "$netwerk" = 0 ] || args+=(--netwerk)
    [ "$vendor" = claude ] || args+=(--vendor "$vendor")
    LAB_SPAWN_ACTUEEL_GETOETST=$$ bash "$zelf" "${args[@]}" >"$uitmap/${namen[$i]}.uit" 2>"$uitmap/${namen[$i]}.fout" &
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
BELEID_BUN=$(command -v bun 2>/dev/null || true)
veilig_bun() ( cd "$HIER" && env -u BUN_OPTIONS -u NODE_OPTIONS "$BUN" "$@"; )
# Hulpscripts draaien vanuit de eigen bronmap zonder geërfde preloads.
if [ -z "$lead" ] && command -v "$BUN" >/dev/null 2>&1; then
  lead=$(veilig_bun "$HIER/leadnaam.ts" eigen 2>/dev/null || true)
fi
[ -n "$lead" ] || lead="${LAB_LEAD_NAAM:-}"

[ -n "$naam" ] || fout "--naam ontbreekt"
[[ $naam =~ ^[A-Za-z0-9._-]+$ ]] || fout "naam '$naam' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
[[ $naam =~ ^[Cc][Oo][Dd][Ee][Xx]-[0-9A-Fa-f]{12}$ ]] && fout "naam '$naam' is gereserveerd: de vorm codex-<12 hex> (hoofd- of kleine letters) is voor afgeleide namen van Codex-sessies zonder identiteit (#685)"
[ -n "$opdracht" ] || fout "--opdracht ontbreekt"
case $opdracht in *$'\n'*|*$'\r'*|*"'"*) fout "opdrachtpad mag geen regeleinde of enkele aanhalingsteken bevatten" ;; esac
[ -f "$opdracht" ] || fout "opdrachtbestand bestaat niet: $opdracht"
if [ "$vendor" = codex ]; then
  [[ $model =~ ^[A-Za-z0-9._-]*$ ]] || fout "--model '$model' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
  [ "$sublead" = 0 ] || fout "--sublead vraagt Claude (de Agent-tool); gebruik --vendor claude"
else
  case $model in ""|sonnet|opus) ;; *) fout "--model moet sonnet of opus zijn, niet '$model'" ;; esac
fi
[ -d "$map" ] || fout "map bestaat niet: $map"
if [ "$vendor" = codex ]; then
  KLAAR_RE='Ask Codex|^[│ ]*› *$' KLAAR_TEKST='Ask Codex' VERTROUWEN_TEKST='Hooks need review' BEWIJS_RE='^[[:space:]]*• ' BEWIJS_TEKST='•'
else
  KLAAR_RE='auto mode|^[│ ]*❯ *$' KLAAR_TEKST='auto mode' VERTROUWEN_TEKST='Quick safety check' BEWIJS_RE='⏺' BEWIJS_TEKST='⏺'
fi
[ -n "$lead" ] || fout "naam van de lead ontbreekt: geef --lead of zet LAB_LEAD_NAAM"
[[ $lead =~ ^[A-Za-z0-9._-]+$ ]] || fout "lead-naam '$lead' mag alleen letters, cijfers, punt, streepje en underscore bevatten"
if command -v "$BUN" >/dev/null 2>&1; then
  # exit 3 = dubbele naam (blokkeert); elke andere fout: waarschuwing en doorgaan (fail-open)
  rc=0
  dubbel=$(veilig_bun "$HIER/leadnaam.ts" dubbel "$lead" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 3 ]; then echo "$dubbel" >&2; exit 1; fi
  [ "$rc" = 0 ] || echo "spawn: waarschuwing: controle op dubbele leadnaam mislukt (exit $rc); ga door. $dubbel" >&2
  # Controle 2: --lead (of LAB_LEAD_NAAM) moet een levende lead in het register zijn, anders komt elk rapport van de werker nergens aan
  # (27 okt: lead zonder LAB_AGENT_ROL gestart, peers.send gaf "onbekend"). exit 4 = onbekend (blokkeert); andere fout: waarschuwing.
  rc=0
  onbekend=$(veilig_bun "$HIER/leadnaam.ts" bekend "$lead" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 4 ]; then echo "$onbekend" >&2; exit 1; fi
  [ "$rc" = 0 ] || echo "spawn: waarschuwing: controle op de leadnaam in het register mislukt (exit $rc); ga door. $onbekend" >&2
fi
[ -z "$workflow" ] || [ "$sublead" = 1 ] || fout "--workflow hoort bij --sublead"
[ "$sublead" = 0 ] || [ -z "$vervolg" ] || fout "--sublead en --vervolg sluiten elkaar uit"
if [ -n "$vervolg" ]; then
  [[ $vervolg =~ ^[A-Za-z0-9._/-]+$ ]] || fout "tak '$vervolg' mag alleen letters, cijfers, punt, streepje, underscore en slash bevatten"
  # GIT_*-variabelen (pre-push-hook) zouden de controle naar een andere repo leiden
  (
    while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep '^GIT_' || true)
    # de map kan van een eerdere werker zijn: geen fsmonitor of hooks daarvan (zie scripts/lead/git-hard.ts)
    git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.ignoreSubmodules=all -C "$map" rev-parse --verify --quiet "refs/heads/$vervolg" >/dev/null ||
      git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.ignoreSubmodules=all -C "$map" rev-parse --verify --quiet "refs/remotes/origin/$vervolg" >/dev/null
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
  # de map kan van een werker zijn: geen fsmonitor of hooks daarvan (zie scripts/lead/git-hard.ts)
  git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.ignoreSubmodules=all "$@"
)

# Git in de gedeelde .git van de lead (of in LEAD_GITDIR), niet via de worktree van de werker; zonder GIT_*, hooks, fsmonitor en replace-refs.
git_lead() (
  while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep '^GIT_' || true)
  export GIT_NO_REPLACE_OBJECTS=1
  git --git-dir="${LEAD_GITDIR:-$GEMEEN_DIR}" -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.ignoreSubmodules=all -c core.commitGraph=false "$@"
)

t3_bin() {
  if [ -n "${LAB_T3:-}" ]; then echo "$LAB_T3"; return; fi
  command -v t3 2>/dev/null && return
  # de desktop-app installeert de server buiten PATH
  ls -d "$HOME"/.t3/runtime/versions/*/t3 2>/dev/null | sort -V | tail -n 1
}

# Codex-threads in T3 hebben geen eigen omgeving: de identiteit gaat naar <staat>/identiteit/<sha256 van de checkout>.json,
# dat codex-wrap.sh voor sessieregistratie en berichtroutering gebruikt.
STAAT="${LAB_LEAD_STAAT:-$HOME/.local/state/lab-lead}"
identiteit_pad() {
  local echt hash
  echt=$(cd "$map" && pwd -P)
  hash=$(printf '%s' "$echt" | shasum -a 256 | cut -c1-24)
  echo "$STAAT/identiteit/$hash.json"
}

# Is $map een eigen (linked) worktree? De hoofdcheckout krijgt nooit een identiteit: iedereen met dezelfde cwd zou die erven.
eigen_worktree() {
  local gemeen eigen
  # Elke rev-parse apart toetsen: onder bash 3.2 laat `cd ""` (een mislukte git in $(…)) de werkmap staan en slaagt.
  gemeen=$(git_schoon -C "$map" rev-parse --git-common-dir 2>/dev/null) || return 1
  [ -n "$gemeen" ] || return 1
  case $gemeen in /*) ;; *) gemeen="$map/$gemeen" ;; esac
  gemeen=$(cd "$gemeen" 2>/dev/null && pwd -P) || return 1
  eigen=$(git_schoon -C "$map" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  [ -n "$eigen" ] || return 1
  eigen=$(cd "$eigen" 2>/dev/null && pwd -P) || return 1
  GEMEEN_DIR=$gemeen EIGEN_DIR=$eigen
  [ -n "$gemeen" ] && [ -n "$eigen" ] && [ "$eigen" != "$gemeen" ]
}

# Een andere sessie in dezelfde checkout? Dan weigeren (de identiteit is per checkout, niet per sessie).
identiteit_vrij() {
  local inst bestaand
  inst=$(identiteit_pad)
  [ -f "$inst" ] || return 0
  bestaand=$(jq -r '.naam // ""' "$inst" 2>/dev/null || true)
  [ -z "$bestaand" ] || [ "$bestaand" = "$naam" ] ||
    fout "$map draagt al de identiteit van sessie '$bestaand' ($inst); één Codex-sessie per checkout. Is die klaar, haal dan dat bestand weg (of wacht tot hij na 12 u verloopt)"
  # Dezelfde naam mag opnieuw (een herstart), maar niet zolang de vorige spawn nog leeft in het register.
  local oud_id r
  oud_id=$(jq -r '.spawn_id // ""' "$inst" 2>/dev/null || true)
  if [ -n "$oud_id" ] && [ -d "$STAAT/register" ]; then
    for r in "$STAAT"/register/*.json; do
      [ -f "$r" ] || continue
      if jq -e --arg s "$oud_id" '.spawn_id == $s and .soort != "subagent" and .toestand != "weg"' "$r" >/dev/null 2>&1; then
        fout "sessie '$naam' draait nog (spawn $oud_id, register $(basename "$r")) in $map; wacht tot hij klaar is (SessionEnd), of haal $inst weg als hij dood is"
      fi
    done
  fi
}

# Schrijft <staat>/identiteit/<hash>.json (0600 in een map 0700). ts in ms: de identiteit verloopt na 12 u (register.ts).
schrijf_identiteit() {
  local inst tmp
  inst=$(identiteit_pad)
  mkdir -p "$STAAT/identiteit" && chmod 700 "$STAAT/identiteit"
  tmp=$(mktemp "$inst.XXXXXX")
  # De tak van de worktree op dit moment als diagnostiek bij de sessie-identiteit.
  local tak=""
  if [ -n "${EIGEN_DIR:-}" ]; then tak=$(git_schoon --git-dir="$EIGEN_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true); fi
  jq -n --arg n "$naam" --arg r "$rol" --arg l "$lead" --arg o "$opdracht" --arg s "$spawn_id" --arg k "$tak" --argjson ts "$(( $(date +%s) * 1000 ))" \
    '{naam: $n, rol: $r, lead: $l, opdracht: $o, spawn_id: $s, ts: $ts} + (if $k == "" then {} else {tak: $k} end)' >"$tmp" || { rm -f "$tmp"; fout "kon $inst niet schrijven"; }
  chmod 600 "$tmp"
  mv "$tmp" "$inst"
  ID_GESCHREVEN=$inst
}

# De checkout-identiteit mag niet naar een gedeelde hoofdcheckout lekken.
# Geen profiel-, hooktrust-, login- of rolbeleid als startvoorwaarde.
codex_controles() {
  eigen_worktree || fout "--vendor codex eist een eigen worktree als --map voor de sessie-identiteit, niet de hoofdcheckout: $map"
}

t3_controleer_map() {
  command -v jq >/dev/null 2>&1 || fout "--t3 heeft jq nodig"
  local top inst bestaand
  top=$(git_schoon -C "$map" rev-parse --show-toplevel 2>/dev/null) || fout "--t3: $map is geen git-checkout"
  [ "$(cd "$top" && pwd -P)" = "$(cd "$map" && pwd -P)" ] || fout "--t3: --map moet de wortel van een worktree zijn ($top), geen submap"
  eigen_worktree || fout "--t3: $map is de hoofdcheckout; maak een eigen worktree (git worktree add) en geef die als --map"
  if [ "$vendor" = codex ]; then
    identiteit_vrij
    return 0
  fi
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
  if [ "$vendor" = codex ]; then
    provider="${LAB_T3_PROVIDER:-codex}"
    model_slug="${model:-${LAB_T3_MODEL:-gpt-6-luna}}"
    inst=$(identiteit_pad)
  else
    provider="${LAB_T3_PROVIDER:-claudeAgent}"
    case $model in
      sonnet) model_slug=claude-sonnet-5-5 ;;
      opus) model_slug=claude-opus-5-5 ;;
      *) model_slug="${LAB_T3_MODEL:-claude-opus-5-5}" ;;
    esac
    inst="$map/.claude/settings.local.json"
  fi
  if [ "$droog" = 1 ]; then
    if [ "$vendor" = codex ]; then
      echo "droog: schrijf de identiteit (naam=$naam rol=$rol lead=$lead opdracht=$opdracht_q spawn_id=$spawn_id) naar $inst; codex-wrap.sh zet die als LAB_AGENT_ROL e.d. in elke hook"
    else
      echo "droog: zet env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q LAB_SPAWN_ID=$spawn_id in $inst (overige sleutels blijven)"
    fi
    echo "droog: ${bin:-t3} project add --title $naam $map (alleen als de map nog geen T3-project is)"
    echo "droog: ${bin:-t3} thread start --title $naam --provider $provider --model $model_slug $map - (startzin op stdin)"
    echo "droog: startzin: $zin"
    echo "droog: controleer met thread show dat de thread aan het werk is (max ${BEWIJS}s); laatste regel t3:<thread-id>"
    exit 0
  fi
  [ -n "$bin" ] && [ -x "$bin" ] || fout "--t3: t3 niet gevonden (zet LAB_T3, of verbind T3 Code eenmaal met deze machine zodat ~/.t3/runtime bestaat)"

  if [ "$vendor" = codex ]; then
    schrijf_identiteit
  else
    mkdir -p "$map/.claude"
    [ -f "$inst" ] || echo '{}' >"$inst"
    tmp=$(mktemp "$inst.XXXXXX")
    jq --arg n "$naam" --arg r "$rol" --arg l "$lead" --arg o "$opdracht" --arg s "$spawn_id" \
      '.env = ((.env // {}) + {LAB_AGENT_NAAM: $n, LAB_AGENT_ROL: $r, LAB_LEAD_NAAM: $l, LAB_OPDRACHT: $o, LAB_SPAWN_ID: $s})' \
      "$inst" >"$tmp" || { rm -f "$tmp"; fout "--t3: kon $inst niet bijwerken"; }
    mv "$tmp" "$inst"
  fi

  if ! (cd "$map" && "$bin" thread list >/dev/null 2>&1); then
    uit=$("$bin" project add --title "$naam" "$map" 2>&1) || fout_ruim "--t3: project toevoegen mislukte (draait de T3-server?): $uit"
  fi
  uit=$(printf '%s\n' "$zin" | "$bin" thread start --title "$naam" --provider "$provider" --model "$model_slug" "$map" - 2>&1) ||
    fout_ruim "--t3: thread starten mislukte: $uit"
  # t3 drukt het id af (in een terminal met "Thread " ervoor): de laatste niet-lege regel
  id=$(printf '%s\n' "$uit" | sed -e 's/^Thread //' -e '/^[[:space:]]*$/d' | tail -n 1)
  [[ $id =~ ^[A-Za-z0-9:._%-]+$ ]] || fout_ruim "--t3: geen thread-id in de uitvoer van t3: $uit"
  if [ "$vendor" = codex ]; then
    # het thread-id is de wekroute (t3 thread send) en LAB_T3_THREAD voor de hooks; de thread draait al, dus het kan pas nu
    tmp=$(mktemp "$inst.XXXXXX")
    jq --arg t "$id" '. + {t3_thread: $t}' "$inst" >"$tmp" && chmod 600 "$tmp" && mv "$tmp" "$inst" || { rm -f "$tmp"; echo "spawn: waarschuwing: kon t3_thread niet in $inst zetten" >&2; }
  fi

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

[ "$vendor" != codex ] || codex_controles

rol=agent
[ "$sublead" = 0 ] || rol=sublead
[ -z "$vervolg" ] || rol=vervolg
# Identiteit voor de hooks (scripts/lead/hooks): de sessie erft deze omgeving.
# Het opdrachtpad kan een spatie bevatten, dus tussen enkele quotes (een ' is al geweigerd).
opdracht_q=$opdracht
case $opdracht_q in *[!A-Za-z0-9_/.:+=@-]*) opdracht_q="'$opdracht_q'" ;; esac
# Eenmalig id: een kindproces dat deze omgeving erft (claude -p) herkent de hook er aan dat het geen eigen sessie is.
spawn_id="$(date +%s)-$$-$RANDOM"
# LAB_LEAD_STAAT mee als hij gezet is, zodat de hooks en de peers-MCP hetzelfde register zien als deze aanroep: de pane erft de
# omgeving van de tmux-server, niet die van deze aanroep (28 okt: een Claude-werker uit een sessie met een tijdelijke staat
# registreerde zich in het standaardregister en was onbekend op de bus).
staat_q=""
[ -z "${LAB_LEAD_STAAT:-}" ] || staat_q=" LAB_LEAD_STAAT=$(printf '%q' "$LAB_LEAD_STAAT")"
cmd="env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q LAB_SPAWN_ID=$spawn_id$staat_q claude -n $naam"
if [ -n "$model" ]; then cmd="$cmd --model $model"; fi
server="${LAB_PEERS_SERVER:-$HIER/peers/server.ts}"
bun_abs=$(command -v "$BUN" 2>/dev/null || true)
if [ "$vendor" = claude ] && [ "$t3" = 0 ]; then
  # De peers-MCP alleen voor deze sessie (--mcp-config), nooit globaal (besluit Brian 27 okt: geen `claude mcp add --scope user`).
  # Zonder deze server krijgt een Claude-werker wel het seintje van de wekker, maar kan hij zijn inbox niet lezen (echte demo).
  # --allowedTools mcp__peers: geen toestemmingsvraag in een pane zonder mens; de tools zijn de bus, net als SendMessage.
  if [ -f "$server" ] && [ -n "$bun_abs" ] && [[ $server$bun_abs != *"'"* && $server$bun_abs != *'"'* && $server$bun_abs != *\\* ]]; then
    mcp_env="\"LAB_AGENT_NAAM\":\"$naam\",\"LAB_LEAD_NAAM\":\"$lead\""
    [ -z "${LAB_LEAD_STAAT:-}" ] || [[ $LAB_LEAD_STAAT == *"'"* || $LAB_LEAD_STAAT == *'"'* || $LAB_LEAD_STAAT == *\\* ]] || mcp_env="$mcp_env,\"LAB_LEAD_STAAT\":\"$LAB_LEAD_STAAT\""
    cmd="$cmd --mcp-config '{\"mcpServers\":{\"peers\":{\"command\":\"$bun_abs\",\"args\":[\"$server\"],\"env\":{$mcp_env}}}}' --allowedTools=mcp__peers"
  else
    echo "spawn: waarschuwing: peers-MCP ($server) of bun ontbreekt, of het pad bevat een quote of backslash; de sessie start zonder de tools van peers" >&2
  fi
fi
if [ "$vendor" = codex ]; then
  cmd="env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q LAB_SPAWN_ID=$spawn_id$staat_q codex -C $(printf '%q' "$map")"
  [ -z "$model" ] || cmd="$cmd -m $model"
  # De peers-MCP is een optie per sessie; de bestaande Codex-config blijft van toepassing.
  if [ "$t3" = 1 ]; then
    :   # een T3-thread krijgt geen -c per thread: de peers-MCP leest de identiteit uit <staat>/identiteit (zie peers/server.ts)
  elif [ -f "$server" ] && [ -n "$bun_abs" ] && [[ $server$bun_abs != *"'"* && $server$bun_abs != *'"'* ]]; then
    cmd="$cmd -c 'mcp_servers.peers.command=\"$bun_abs\"' -c 'mcp_servers.peers.args=[\"$server\"]'"
    # Een statische env-tabel per spawn (Codex geeft een MCP-server niet de omgeving van de sessie door).
    mcp_env="LAB_AGENT_NAAM=\"$naam\",LAB_LEAD_NAAM=\"$lead\""
    [ -z "${LAB_LEAD_STAAT:-}" ] || [[ $LAB_LEAD_STAAT == *"'"* || $LAB_LEAD_STAAT == *'"'* ]] || mcp_env="$mcp_env,LAB_LEAD_STAAT=\"$LAB_LEAD_STAAT\""
    cmd="$cmd -c 'mcp_servers.peers.env={$mcp_env}' -c 'mcp_servers.peers.default_tools_approval_mode=\"approve\"'"
  else
    echo "spawn: waarschuwing: peers-MCP ($server) of bun ontbreekt; de sessie start zonder peers.send" >&2
  fi
fi
pad=$opdracht
case $pad in *[[:space:]]*) pad="'$pad'" ;; esac
zin="Je lead is $lead. Jij bent sessie $naam. Lees $pad en voer die uit. Je kunt je resultaat delen via SendMessage (to: $lead)."
if [ "$sublead" = 1 ]; then
  zin="Je lead is $lead. Jij bent sessie $naam, sub-lead. Lees $pad en voer die uit. De optionele coördinatiehulp staat in scripts/lead/sublead.md. Je kunt je resultaat delen via SendMessage (to: $lead)."
  [ -z "$workflow" ] || zin="$zin Workflowmarkering: $workflow; de optionele hulp staat in scripts/lead/vaste-cyclus.js."
elif [ -n "$vervolg" ]; then
  zin="Je lead is $lead. Jij bent sessie $naam, een vervolgsessie op tak $vervolg. Lees $pad en voer die uit; git log origin/main..$vervolg en git diff origin/main...$vervolg geven takcontext. Je kunt je resultaat delen via SendMessage (to: $lead)."
fi

if [ "$vendor" = codex ]; then
  # Codex kent geen SendMessage: het rapport aan de lead is de tool send van de MCP-server peers.
  zin="${zin//via SendMessage (to: $lead)/met de tool send van MCP-server peers (naar: $lead)}"

fi

if [ "$t3" = 1 ]; then
  zin="$zin Je draait als thread in T3 Code: gebruik geen AskUserQuestion (de lead ziet die vraag niet en een bericht van de lead laat hem vastlopen), maar zet een vraag in tekst in je rapport. Zet je laatste rapport ook als je laatste antwoord in deze thread."
  t3_start "$zin"   # eindigt altijd met exit
fi

if [ "$droog" = 1 ]; then
  echo "droog: $SPAWN window $map \"$cmd\""
  echo "droog: tmux set -p -t <pane> @agent_rol $rol; tmux set -p -t <pane> @agent_naam $naam"
  if [ "$vendor" = codex ]; then
    echo "droog: schrijf de identiteit (naam=$naam rol=$rol) naar $(identiteit_pad) (0600 in een map 0700); codex-wrap.sh zet die in elke hook"
    [ "$t3" = 1 ] || [ "$netwerk" = 1 ] || [ ! -f "$map/package.json" ] || echo "droog: bun install --ignore-scripts --frozen-lockfile in $map (buiten de sandbox, zonder netwerk kan de werker het niet)"
  fi
  echo "droog: wacht (max ${WACHT}s) tot de pane '$KLAAR_TEKST' of de promptregel toont"
  echo "droog: toont de pane de vertrouwensvraag ('$VERTROUWEN_TEKST'), dan melding aan Brian (tmux display-message + stderr) en wachten (max ${WACHT_VERTROUWEN}s, WACHT_VERTROUWEN) tot de vraag weg is; nooit zelf antwoorden; bij time-out fout met pane en startzin"
  echo "droog: tmux send-keys -l \"$zin\" + Enter"
  echo "droog: controleer dat er een tool-aanroep ($BEWIJS_TEKST) verschijnt (max ${BEWIJS}s)"
  exit 0
fi

if [ "$vendor" = codex ]; then
  identiteit_vrij
  # Zonder netwerk kan de werker niet installeren: doe het hier, buiten de sandbox. Dit draait code van de worktree buiten de sandbox,
  # dus: geen lifecycle-scripts, alleen wat het lockfile vastlegt, en geen bunfig.toml/.npmrc die afwijkt van origin/main
  # (die kunnen registry of cache omleggen). Vóór schrijf_identiteit: een mislukking laat niets achter, en er loopt geen
  # werker in deze map (identiteit_vrij).
  if [ "$t3" = 0 ] && [ "$netwerk" = 0 ] && [ -f "$map/package.json" ]; then
    # Een node_modules die een symlink is: find slaat hem hieronder over (prune op de naam), maar bun install schrijft erdoorheen naar een
    # map buiten de worktree. Weiger er elke (ook geneste, buiten echte node_modules-mappen).
    gekoppeld=$(find "$map" \( -name .git -o \( -name node_modules -type d \) \) -prune -o \( -name node_modules -type l \) -print -quit)
    [ -z "$gekoppeld" ] || fout "${gekoppeld#"$map"/} in $map is een symlink: bun install buiten de sandbox zou erdoorheen schrijven. Haal hem weg, of start met --netwerk: dan draait de werker zelf bun install in de sandbox"
    # De werker kan package.json, bun.lock, bunfig.toml, .npmrc en .env* in zijn worktree vervangen (bij een herstart of --vervolg komen ze van
    # hem): een afhankelijkheid http://…/x.tgz?data=… is een GET buiten de sandbox, een file:-afhankelijkheid kopieert mappen,
    # bunfig/.npmrc/.env (BUN_CONFIG_REGISTRY) leggen registry en cache om, en een symlink laat find/bun een map volgen die niet in de
    # vergelijking zit. Daarom alleen installeren als ze identiek zijn aan origin/main, gelezen uit een tijdelijke bare repo van de lead die
    # vers van origin haalt (fetch controleert de hashes): de gedeelde .git zelf is niet te vertrouwen, want de werker kan in objects/
    # een los object of pack onder de sha van een bestaande blob zetten, en refs/remotes/origin/main is ook schrijfbaar.
    bron=$(mktemp -d) || fout "kon geen tijdelijke map maken voor de vergelijking met origin/main"
    bronrepo="$bron/bron.git"
    url=$(git_lead config --get remote.origin.url 2>/dev/null || true)
    vertrouwd=""
    if [ -n "$url" ] && LEAD_GITDIR="$bronrepo" git_lead init -q --bare 2>/dev/null &&
      LEAD_GITDIR="$bronrepo" git_lead fetch -q --no-tags --depth=1 "$url" refs/heads/main 2>/dev/null; then
      vertrouwd=$(LEAD_GITDIR="$bronrepo" git_lead rev-parse --verify -q 'FETCH_HEAD^{commit}' 2>/dev/null || true)
    fi
    if [ -z "$vertrouwd" ]; then
      rm -rf "$bron"
      fout "kon origin/main niet ophalen om package.json, bun.lock, bunfig.toml, .npmrc en .env* te vergelijken; geen bun install buiten de sandbox. Start met --netwerk (dan installeert de werker zelf)"
    fi
    afwijking=""
    while IFS= read -r -d '' f; do
      rel=${f#"$map"/}
      if [ -L "$f" ] || ! LEAD_GITDIR="$bronrepo" git_lead show "$vertrouwd:$rel" 2>/dev/null | cmp -s - "$f"; then
        afwijking=$rel
        break
      fi
    done < <(find "$map" \( -name node_modules -o -name .git \) -prune -o \( -type l -o -name package.json -o -name bunfig.toml -o -name .npmrc -o -name '.env*' -o -name bun.lock -o -name bun.lockb \) -print0)
    rm -rf "$bron"
    [ -z "$afwijking" ] || fout "$afwijking in $map wijkt af van origin/main (of is nieuw, of een symlink): bun install buiten de werker zou hem volgen. Herstel het bestand, of start met --netwerk zodat de werker zelf installeert"
    BUN_INSTALL_ARGS=()
    while IFS= read -r regel; do BUN_INSTALL_ARGS+=("$regel"); done < <(cd "$HIER" && env -u BUN_OPTIONS -u NODE_OPTIONS "$BELEID_BUN" "$HIER/beleid/codex-werker.ts" bun-install-args)
    [ "${BUN_INSTALL_ARGS[*]}" = 'install --ignore-scripts --frozen-lockfile' ] || fout "kon het Codex-werkerinstallatiecontract niet lezen"
    (cd "$map" && "$BUN" "${BUN_INSTALL_ARGS[@]}" >&2) || fout "bun install --ignore-scripts --frozen-lockfile in $map mislukte; de werker heeft zonder netwerk geen installatie. Los het op of start met --netwerk"
  fi
  schrijf_identiteit
fi

pane=$(bash "$SPAWN" window "$map" "$cmd" | tail -n 1) || pane=""   # pipefail: een falend spawn-script moet de foutmelding en de opruiming krijgen
[[ $pane =~ ^%[0-9]+$ ]] || fout_ruim "kreeg geen pane-id terug van het spawn-script: '$pane'"

tmux set -p -t "$pane" @agent_rol "$rol" 2>/dev/null || true
tmux set -p -t "$pane" @agent_naam "$naam" 2>/dev/null || true

# De echte vertrouwensvraag van Claude Code ("Quick safety check: Is this a project you created or one you trust?"
# met de keuze "Yes, I trust this folder"). Andere vragen tellen niet mee.
VERTROUWEN='Quick safety check|Yes, I trust this folder'
if [ "$vendor" = codex ]; then VERTROUWEN='Hooks need review|trust the contents|Do you trust'; fi

klaar=0 verstreken=0 gemeld=0 start_v=0
while :; do
  scherm=$(tmux capture-pane -p -t "$pane" 2>/dev/null || true)
  # eerst de prompt: de vertrouwenstekst kan na het bevestigen als scrollback boven de prompt blijven staan
  if printf '%s\n' "$scherm" | grep -Eq "$KLAAR_RE"; then klaar=1; break; fi
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
if [ "$vendor" = codex ] && [ "$ENTER" -gt 0 ]; then sleep "$ENTER"; fi
tmux send-keys -t "$pane" Enter

verstreken=0
while :; do
  if tmux capture-pane -p -t "$pane" 2>/dev/null | grep -Eq "$BEWIJS_RE"; then
    echo "$pane"; exit 0
  fi
  [ "$verstreken" -lt "$BEWIJS" ] || break
  sleep "$POLS"; verstreken=$((verstreken + POLS))
done
fout "de startzin is getypt in pane $pane, maar er verscheen geen tool-aanroep ($BEWIJS_TEKST) binnen ${BEWIJS}s; kijk zelf in de sessie"
