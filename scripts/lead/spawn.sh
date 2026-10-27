#!/usr/bin/env bash
# Start een Claude-sessie in een eigen tmux-venster en geef die een opdracht.
# Gebruik: scripts/lead/spawn.sh --naam <n> --opdracht <bestand> [--model sonnet|opus]
#          [--map <pad>] [--lead <unieke naam>] [--sublead [--workflow <JJJJ-MM-DD>]] [--vervolg <tak>] [--t3] [--droog]
#          [--vendor claude|codex] [--netwerk]
#          --vendor codex: een Codex-sessie (`codex -C <map>`; --model is dan een Codex-model); standaard claude. Eist een eigen
#          worktree als --map (nooit de hoofdcheckout) en een Codex-config met de grenzen-hook (grenzen.sh, vertrouwd door
#          codex-installeer.ts); anders weigert spawn. De rol staat in de pane-omgeving (tmux) en altijd in
#          <staat>/identiteit/<hash van de checkout>.json (codex-wrap.sh zet die in de omgeving van elke hook, ook in T3).
#          Sandbox (tmux): de werker draait met een permissieprofiel (workspace-write-achtig, netwerk UIT): schrijven alleen in de
#          worktree, een eigen tmp-map /tmp/lab-werker-<naam> (TMPDIR wijst ernaar), de bun-cache, <common>/objects, refs, logs en worktrees/<naam>; hooks, config, commondir en
#          gitdir blijven read-only; sleutelmappen zijn onleesbaar; geen escalatieverzoeken (-a never). Een T3-thread krijgt
#          geen -c en dus geen sandbox: --t3 met --vendor codex weigert tenzij --zonder-sandbox, een expliciete escape die alleen
#          op aanwijzing van Brian mag. Netwerk is standaard uit (ook unix-sockets: EPERM, dus geen tmux send-keys-ontsnapping);
#          --netwerk zet het aan (Brian of de lead, bewust; niet met --t3). Zonder netwerk draait spawn eerst
#          `bun install --ignore-scripts --frozen-lockfile` in de worktree (buiten de sandbox, als er een package.json is; geweigerd bij een
#          bunfig.toml of .npmrc die afwijkt van origin/main) en pusht de werker niet en draait hij geen gh: hij meldt "klaar om te pushen
#          op <sha>" en de lead pusht met scripts/lead/push-werker.sh. Een bestaande <map>/.codex weigert spawn (die config draait buiten
#          de sandbox).
#          De upstream van de werkertak (origin/<tak>) zet spawn vooraf, want .git/config is read-only.
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

naam="" opdracht="" model="" map="$PWD" lead="" droog=0 sublead=0 vervolg="" workflow="" meerdere="" t3=0 vendor=claude zonder_sandbox=0 netwerk=0
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
    --zonder-sandbox) zonder_sandbox=1; shift ;;
    --netwerk) netwerk=1; shift ;;
    --vendor) waarde "$@"; vendor=$2; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) fout "onbekende optie: $1" ;;
  esac
done

case $vendor in claude|codex) ;; *) fout "--vendor moet claude of codex zijn, niet '$vendor'" ;; esac
[ "$netwerk" = 0 ] || [ "$vendor" = codex ] || fout "--netwerk hoort bij --vendor codex"
[ "$netwerk" = 0 ] || [ "$t3" = 0 ] || fout "--netwerk past niet bij --t3: een T3-thread heeft geen sandbox en dus geen netwerkprofiel om aan te zetten"

# --- Controle 1: draait deze spawn.sh uit een checkout die achterloopt op origin/main? --------------------------
# Een verouderde scripts/lead/ start werkers zonder de nieuwste grenzen (27 okt: Codex zonder netwerk-uit-sandbox, #683/#692).
# Achter = origin/main heeft een commit in scripts/lead/ die HEAD mist (een tak die vooruit loopt of ongerelateerd werk heeft telt niet).
# Weigert voor elke vendor en ook met --droog. Geen repo of geen origin/main: waarschuwing en door. Een mislukte fetch (10 s) ook.
# LAB_SPAWN_REPO en LAB_SPAWN_FETCH_S zijn test-haken. Override: LAB_SPAWN_NIET_ACTUEEL_OK=1 (waarschuwing).
HIER=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
controleer_actueel() (
  while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep '^GIT_' || true)
  local repo=${LAB_SPAWN_REPO:-$HIER/../..} fetch_s=${LAB_SPAWN_FETCH_S:-10} top fp wp rc=0 achter
  g() { git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.ignoreSubmodules=all -C "$repo" "$@"; }
  top=$(g rev-parse --show-toplevel 2>/dev/null) || { echo "spawn: waarschuwing: $repo is geen git-repo; actualiteit van scripts/lead/ niet getoetst" >&2; return 0; }
  if g remote get-url origin >/dev/null 2>&1; then
    g fetch --quiet origin main >/dev/null 2>&1 &
    fp=$!
    ( sleep "$fetch_s"; kill "$fp" 2>/dev/null ) >/dev/null 2>&1 &
    wp=$!
    wait "$fp" || rc=$?
    kill "$wp" 2>/dev/null || true
    [ "$rc" = 0 ] || echo "spawn: waarschuwing: ophalen van origin/main mislukte (exit $rc); vergelijk met de lokale origin/main" >&2
  fi
  g rev-parse --verify --quiet refs/remotes/origin/main >/dev/null || { echo "spawn: waarschuwing: geen origin/main in $top; actualiteit van scripts/lead/ niet getoetst" >&2; return 0; }
  achter=$(g rev-list --count HEAD..origin/main -- scripts/lead/ 2>/dev/null) || { echo "spawn: waarschuwing: vergelijking met origin/main mislukte; actualiteit niet getoetst" >&2; return 0; }
  [ "$achter" != 0 ] || return 0
  if [ "${LAB_SPAWN_NIET_ACTUEEL_OK:-}" = 1 ]; then
    echo "spawn: waarschuwing: scripts/lead/ in $top loopt $achter commit(s) achter op origin/main; doorgaan op LAB_SPAWN_NIET_ACTUEEL_OK=1" >&2
    return 0
  fi
  echo "spawn: scripts/lead/ in $top loopt $achter commit(s) achter op origin/main (een werker zou zonder de nieuwste grenzen starten); draai: git -C $top pull --ff-only (bewust achterlopen: LAB_SPAWN_NIET_ACTUEEL_OK=1)" >&2
  return 1
)
controleer_actueel || exit 1

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
    [ "$zonder_sandbox" = 0 ] || args+=(--zonder-sandbox)
    [ "$netwerk" = 0 ] || args+=(--netwerk)
    [ "$vendor" = claude ] || args+=(--vendor "$vendor")
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
  dubbel=$("$BUN" "$HIER/leadnaam.ts" dubbel "$lead" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 3 ]; then echo "$dubbel" >&2; exit 1; fi
  [ "$rc" = 0 ] || echo "spawn: waarschuwing: controle op dubbele leadnaam mislukt (exit $rc); ga door. $dubbel" >&2
  # Controle 2: --lead (of LAB_LEAD_NAAM) moet een levende lead in het register zijn, anders komt elk rapport van de werker nergens aan
  # (27 okt: lead zonder LAB_AGENT_ROL gestart, peers.send gaf "onbekend"). exit 4 = onbekend (blokkeert); andere fout: waarschuwing.
  rc=0
  onbekend=$("$BUN" "$HIER/leadnaam.ts" bekend "$lead" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 4 ]; then echo "$onbekend" >&2; exit 1; fi
  [ "$rc" = 0 ] || echo "spawn: waarschuwing: controle op de leadnaam in het register mislukt (exit $rc); ga door. $onbekend" >&2
fi
[ -z "$workflow" ] || [ "$sublead" = 1 ] || fout "--workflow hoort bij --sublead"
[ -z "$workflow" ] || [[ $workflow =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fout "--workflow wil de datum van Brians toestemming (JJJJ-MM-DD), niet '$workflow'"
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
# dat codex-wrap.sh in de omgeving van elke hook zet (ook van grenzen.sh, dat LAB_AGENT_ROL nodig heeft).
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

# De sandbox van een Codex-werker in tmux, als -c-argumenten (een permissieprofiel; zie de kop). Gemeten op codex-cli 0.164.0:
# `sandbox_workspace_write.writable_roots` kan de gedeelde .git niet fijn genoeg opendoen (worktrees/<naam> bevat commondir en
# gitdir, die een git in die worktree naar een andere common dir sturen), een profiel met `read` op die bestanden wel.
# Weigert (nooit half): een pad met ' " \ of een regeleinde kan niet veilig in de TOML.
codex_sandbox() {
  local c e h t b rest m ch
  c=$GEMEEN_DIR e=$EIGEN_DIR h=${HOME:-}
  m=$(cd "$map" && pwd -P) || fout "--vendor codex: $map is niet te openen"
  [ -n "$h" ] && [ -d "$h" ] || fout "--vendor codex: HOME ontbreekt, de sandbox kan niet gebouwd worden"
  h=$(cd "$h" && pwd -P)
  t=$(cd "${LAB_WERKER_TMPWORTEL:-/tmp}" && pwd -P) || fout "--vendor codex: de tmp-wortel ${LAB_WERKER_TMPWORTEL:-/tmp} bestaat niet"
  ch=$CODEX_HOME_GEKOZEN
  for rest in "$m" "$c" "$e" "$h" "$t" "$naam" "$ch"; do
    case $rest in *\'*|*\"*|*\\*|*$'\n'*) fout "--vendor codex: een pad bevat ', \" of \\ en kan niet in de sandbox-config: $rest" ;; esac
  done
  b="$h/.bun/install/cache"
  SANDBOX_FS="\"/\"=\"read\",\"$m\"=\"write\",\"$c/objects\"=\"write\",\"$c/refs\"=\"write\",\"$c/logs\"=\"write\""
  SANDBOX_FS="$SANDBOX_FS,\"$e\"=\"write\",\"$e/commondir\"=\"read\",\"$e/gitdir\"=\"read\",\"$e/config.worktree\"=\"read\""
  # HEAD van de worktree read-only: anders wijst de werker hem naar een andere tak (push-werker leest de tak uit de identiteit, dit is de
  # tweede laag). Een commit schrijft de tak in refs/ en de index in $e, niet HEAD.
  SANDBOX_FS="$SANDBOX_FS,\"$e/HEAD\"=\"read\""
  # refs/replace read-only (refs/ is schrijfbaar): een replace-ref laat merge-base, log en diff van de lead liegen. <worktree>/.git
  # (het bestand dat naar de gitdir wijst) read-only: het zou de gitdir kunnen omleggen.
  SANDBOX_FS="$SANDBOX_FS,\"$c/refs/replace\"=\"read\",\"$m/.git\"=\"read\""
  # Eigen tmp-map als enige tmp-root: niet /tmp als geheel en niet de TMPDIR van de lead (daar staan sessiemappen en sockets van anderen).
  WERKTMP="$t/lab-werker-$naam"
  SANDBOX_FS="$SANDBOX_FS,\"$WERKTMP\"=\"write\""
  # De bun-cache alleen schrijfbaar als de werker zelf mag installeren (--netwerk). Anders vervangt hij een pakket in de cache en linkt de
  # volgende `bun install` van de lead het in, waarna `bun run check` het als de lead draait. Gelezen mag hij ("/"="read").
  [ "$netwerk" = 0 ] || SANDBOX_FS="$SANDBOX_FS,\"$b\"=\"write\""
  # De projectconfig van Codex (<worktree>/.codex/config.toml) draait zijn mcp_servers buiten de sandbox en mag het profiel aanvullen:
  # read-only, ook als de map nog niet bestaat.
  SANDBOX_FS="$SANDBOX_FS,\"$m/.codex\"=\"read\""
  # Sleutelmappen onleesbaar (dezelfde lijst als grenzen.sh), want een write_stdin gaat langs die hook.
  SANDBOX_FS="$SANDBOX_FS,\"$h/.config/klaarover\"=\"none\",\"$h/.config/douane\"=\"none\",\"$h/.config/agentwerkbank\"=\"none\""
  # De CODEX_HOME die spawn gebruikt (kan een andere zijn dan ~/.codex) als geheel onleesbaar: transcripten, geschiedenis, logs, sqlite-staat
  # (ook bestanden die pas na de start ontstaan), config en sleutel. Codex en zijn hooks lezen die buiten de sandbox. Alleen wat de shell
  # van de werker nodig heeft gaat weer op read (een diepere regel wint van de map, zoals $e/HEAD hierboven): shell_snapshots/, skills/,
  # prompts/, rules/ en AGENTS.md. En packages/: de standalone-installatie zet de codex-binary daar (~/.local/bin/codex wijst naar
  # ~/.codex/packages/standalone/current/bin/codex) en de fs-sandboxhelper van Codex start die binary zelf; dicht = "execvp() …
  # Operation not permitted" en codex stopt bij de start (echte demo, 27 okt).
  local d f k
  for d in "$ch" "$h/.codex"; do
    SANDBOX_FS="$SANDBOX_FS,\"$d\"=\"none\""
    for k in shell_snapshots skills prompts rules AGENTS.md packages; do
      SANDBOX_FS="$SANDBOX_FS,\"$d/$k\"=\"read\""
    done
    [ "$ch" != "$h/.codex" ] || break
  done
  # Inloggegevens en tokens: een denylist (alles blijft leesbaar tenzij hier genoemd), geen allowlist. Met --netwerk is een leesbaar
  # token een directe exfiltratieroute. ~/.codex en de CODEX_HOME staan hierboven (als geheel dicht, op een paar leesmappen na).
  local k
  for k in .ssh .config/gh .netrc .git-credentials .aws .azure .kube .docker .npmrc .config/op Library/Keychains \
    .config/glab-cli .gnupg .config/gcloud "Library/Application Support/com.vercel.cli" \
    .claude/projects .claude/.credentials.json .claude/history.jsonl .claude.json; do
    SANDBOX_FS="$SANDBOX_FS,\"$h/$k\"=\"none\""
  done
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
  # De tak van de worktree op dit moment, uit de gitdir aan de kant van de lead: push-werker.sh pusht alleen die tak.
  local tak=""
  if [ -n "${EIGEN_DIR:-}" ]; then tak=$(git_schoon --git-dir="$EIGEN_DIR" symbolic-ref -q --short HEAD 2>/dev/null || true); fi
  jq -n --arg n "$naam" --arg r "$rol" --arg l "$lead" --arg o "$opdracht" --arg s "$spawn_id" --arg k "$tak" --argjson ts "$(( $(date +%s) * 1000 ))" \
    '{naam: $n, rol: $r, lead: $l, opdracht: $o, spawn_id: $s, ts: $ts} + (if $k == "" then {} else {tak: $k} end)' >"$tmp" || { rm -f "$tmp"; fout "kon $inst niet schrijven"; }
  chmod 600 "$tmp"
  mv "$tmp" "$inst"
  ID_GESCHREVEN=$inst
}

# Voorwaarden voor een Codex-werker, vóór alles wat iets schrijft of start:
#  1. --map is een eigen (linked) worktree (git-dir != git-common-dir): de identiteit is per checkout en de hoofdcheckout
#     is van iedereen; zonder identiteit zou de werker zonder rol draaien en dan past grenzen.sh de rolregels niet toe.
#  2. De Codex-config heeft de grenzen-hook (grenzen.sh) mét een geldige trusted_hash; zonder draait hij stil niet.
CODEX_HOME_GEKOZEN=""
codex_controles() {
  CODEX_HOME_GEKOZEN="${CODEX_HOME:-$HOME/.codex}"
  case $CODEX_HOME_GEKOZEN in /*) ;; *) CODEX_HOME_GEKOZEN="$PWD/$CODEX_HOME_GEKOZEN" ;; esac
  local cfg="$CODEX_HOME_GEKOZEN/config.toml" uit rc
  eigen_worktree || fout "--vendor codex eist een eigen worktree als --map (git worktree add), niet de hoofdcheckout of een map zonder eigen worktree: $map"
  if [ -e "$map/.codex" ] || [ -L "$map/.codex" ]; then
    fout "--vendor codex weigert: $map/.codex bestaat (getrackt of niet). Codex laadt <worktree>/.codex/config.toml bij de start; zijn mcp_servers draaien buiten de sandbox en hij kan het profiel aanvullen. Haal de map weg of start in een andere worktree"
  fi
  command -v "$BUN" >/dev/null 2>&1 || fout "--vendor codex heeft bun nodig om de grenzen-hook in $cfg te controleren"
  if [ "$t3" = 1 ]; then
    [ "$zonder_sandbox" = 1 ] || fout "--t3 met --vendor codex weigert: een T3-thread krijgt geen -c per thread en dus niet de sandbox van de tmux-werker (schrijven alleen in de worktree, hooks en config read-only). Start in tmux. --zonder-sandbox is een expliciete escape (de thread draait dan zonder die sandbox) en mag alleen op aanwijzing van Brian"
  else
    codex_sandbox
  fi
  # In T3 kan hosted web search niet per thread uit (geen -c); dan moet de config het zelf niet aanzetten (--web-search).
  # Exit 1 = de grenzen-hook ontbreekt of is niet vertrouwd; exit 3 = web search staat aan (alleen met --web-search).
  rc=0
  if [ "$t3" = 1 ]; then
    uit=$("$BUN" "$HIER/hooks/codex-controle.ts" "$cfg" --web-search --project "$map" 2>&1) || rc=$?
  else
    uit=$("$BUN" "$HIER/hooks/codex-controle.ts" "$cfg" 2>&1) || rc=$?
  fi
  case $rc in
    0) ;;
    3) fout "$uit" ;;
    *) fout "Codex-config niet in orde, de grenzen zouden niet gelden: $uit" ;;
  esac
}

# De sandbox laat de werker .git/config niet schrijven, dus `git push -u` zou na afloop mislukken. Zet de upstream van de werkertak
# daarom hier vooraf (buiten de sandbox): origin + refs/heads/<tak>, ook als die tak op origin nog niet bestaat. Alleen als de tak
# nog geen upstream heeft of die naar main/master wijst (een verse agenttak vanaf origin/main); een andere upstream blijft staan.
# Een losse HEAD, main/master of een repo zonder remote origin: niets doen.
codex_upstream() {
  local tak merge
  tak=$(git_schoon -C "$map" symbolic-ref -q --short HEAD 2>/dev/null) || return 0
  case $tak in ""|main|master) return 0 ;; esac
  git_schoon -C "$map" remote get-url origin >/dev/null 2>&1 || return 0
  merge=$(git_schoon -C "$map" config --get "branch.$tak.merge" 2>/dev/null || true)
  case $merge in ""|refs/heads/main|refs/heads/master) ;; *) return 0 ;; esac
  git_schoon -C "$map" config "branch.$tak.remote" origin &&
    git_schoon -C "$map" config "branch.$tak.merge" "refs/heads/$tak" ||
    echo "spawn: let op: kon de upstream van $tak niet zetten; de werker pusht met 'git push origin $tak' (zonder -u)" >&2
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
cmd="env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q LAB_SPAWN_ID=$spawn_id claude -n $naam"
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
  # LAB_AGENT_ROL staat altijd in de omgeving (grenzen.sh past de hoofdcheckout-regel alleen toe met een rol; Codex stuurt geen agent_id).
  # LAB_LEAD_STAAT mee als hij gezet is, zodat de hooks en de peers-MCP hetzelfde register zien als deze aanroep.
  staat_q=""
  [ -z "${LAB_LEAD_STAAT:-}" ] || staat_q=" LAB_LEAD_STAAT=$(printf '%q' "$LAB_LEAD_STAAT")"
  # CODEX_HOME vast in het startcommando: de pane erft de omgeving van de tmux-server, niet die van deze aanroep, en
  # codex_controles heeft juist de config van dit pad gecontroleerd. (Een T3-thread draait onder T3's eigen CODEX_HOME.)
  codex_home_q=" CODEX_HOME=$(printf '%q' "$CODEX_HOME_GEKOZEN")"
  tmp_q=""
  [ "$t3" = 1 ] || tmp_q=" TMPDIR=$(printf '%q' "$WERKTMP")"
  cmd="env LAB_AGENT_NAAM=$naam LAB_AGENT_ROL=$rol LAB_LEAD_NAAM=$lead LAB_OPDRACHT=$opdracht_q LAB_SPAWN_ID=$spawn_id$tmp_q$staat_q$codex_home_q codex -C $(printf '%q' "$map")"
  [ -z "$model" ] || cmd="$cmd -m $model"
  # Hosted web search uit voor werkers (de uitkomst loopt langs geen hook); --search nooit meegeven. In T3 kan dit niet per
  # thread: codex_controles weigert daar als de config het aanzet. Het -c zet de TUI in embedded mode (zoals de MCP-c's).
  [ "$t3" = 1 ] || cmd="$cmd -c 'web_search=\"disabled\"'"
  # Sandbox: een permissieprofiel (zie codex_sandbox) zonder netwerk (met --netwerk wel), en nooit een escalatieverzoek (-a never): zonder mens in de
  # pane zou een verzoek om buiten de sandbox te draaien blijven hangen, en een goedkeuring zou de sandbox ophouden te zijn.
  net=false; [ "$netwerk" = 0 ] || net=true
  [ "$t3" = 1 ] || cmd="$cmd -a never -c 'default_permissions=\"lab-werker\"' -c 'permissions.lab-werker.filesystem={$SANDBOX_FS}' -c 'permissions.lab-werker.network={enabled=$net}'"
  # De peers-MCP alleen voor deze sessie (-c), nooit globaal in ~/.codex.
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

if [ "$vendor" = codex ]; then
  # Codex kent geen SendMessage: het rapport aan de lead is de tool send van de MCP-server peers.
  zin="${zin//via SendMessage (to: $lead)/met de tool send van MCP-server peers (naar: $lead)}"
  # Zonder netwerk kan de werker niet pushen: de lead pusht en opent de PR.
  if [ "$t3" = 0 ] && [ "$netwerk" = 0 ]; then
    zin="$zin Je hebt geen netwerk: push niet en draai geen gh. Commit in je worktree en meld in je rapport \"klaar om te pushen op <sha>\"; de lead pusht (met scripts/lead/push-werker.sh, nooit met een push vanuit jouw worktree) en opent de PR. Draai nodige postinstall-scripts zelf in je sandbox (spawn installeert met --ignore-scripts)."
  fi
fi
zin="$zin Sluit je laatste rapport aan de lead af met een vaste slotregel (laatste regel, kaal): \`vrij\` als je klaar en opgeruimd bent, of \`wacht op achtergrondrun tot ~HH:MM\` (hoogstens 2 uur vooruit) als je op een achtergrondrun wacht. \"vrij\" ergens anders in de tekst telt niet."

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
    echo "droog: gecontroleerd: $map is een eigen worktree en $CODEX_HOME_GEKOZEN/config.toml heeft de vertrouwde, actuele grenzen-hook"
  fi
  echo "droog: wacht (max ${WACHT}s) tot de pane '$KLAAR_TEKST' of de promptregel toont"
  echo "droog: toont de pane de vertrouwensvraag ('$VERTROUWEN_TEKST'), dan melding aan Brian (tmux display-message + stderr) en wachten (max ${WACHT_VERTROUWEN}s, WACHT_VERTROUWEN) tot de vraag weg is; nooit zelf antwoorden; bij time-out fout met pane en startzin"
  echo "droog: tmux send-keys -l \"$zin\" + Enter"
  echo "droog: controleer dat er een tool-aanroep ($BEWIJS_TEKST) verschijnt (max ${BEWIJS}s)"
  exit 0
fi

# Waarschuwing vooraf (alleen lezen, nooit schrijven): is de map of een bovenliggende map vertrouwd?
vertrouwd=0 d=$map
if [ "$vendor" = claude ] && [ -f "$CLAUDE_JSON" ] && command -v jq >/dev/null 2>&1; then
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
    [ -z "$afwijking" ] || fout "$afwijking in $map wijkt af van origin/main (of is nieuw, of een symlink): bun install buiten de sandbox zou hem volgen. Herstel het bestand, of start met --netwerk: dan draait de werker zelf bun install in de sandbox"
    (cd "$map" && "$BUN" install --ignore-scripts --frozen-lockfile >&2) || fout "bun install --ignore-scripts --frozen-lockfile in $map mislukte; de werker heeft zonder netwerk geen installatie. Los het op of start met --netwerk"
  fi
  mkdir -p -m 700 "$WERKTMP" 2>/dev/null || [ "$t3" = 1 ] || fout "kon de tmp-map $WERKTMP niet maken"
  schrijf_identiteit
  codex_upstream
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
