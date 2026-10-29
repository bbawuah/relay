#!/bin/bash -p
# Optionele PR-mergehulp; GitHub en gewone CI bepalen de mergevoorwaarden. Gebruik: scripts/lead/merge.sh <pr> [--droog]
# Controleert gewone CI en mergebaarheid; geen rol, reviewmarker of lokaal poortstempel.
# Optionele bediening; zie scripts/lead/README.md voor functies en activeringsgrens.
set -euo pipefail
unset BASH_ENV ENV

fout() { echo "merge: geweigerd: $*" >&2; exit 1; }
# Als root-kopie (/usr/local/lib/lab-lead, waar de allow-regel naar wijst): vaste PATH en geen
# overrides uit de omgeving. Vanuit de repo (tests) blijven PATH en de overrides staan.
geinstalleerd=0
[ "$(cd "$(dirname "$0")" && pwd -P)" = /usr/local/lib/lab-lead ] && geinstalleerd=1
if [ "$geinstalleerd" = 1 ]; then
  PATH=/usr/bin:/bin:/opt/homebrew/bin
  export PATH
  unset LAB_MERGE_CHECK LAB_MERGE_CI_WORKFLOW LAB_MERGE_STEMPELS
fi

CHECK="${LAB_MERGE_CHECK:-poort}"
# Workflownaam van de CI: één bron in lead.conf (ook voor wachtrij.ts), override met LAB_MERGE_CI_WORKFLOW.
# lead.conf wordt niet ge-sourcet (geen code uitvoeren uit een bestand naast het script): alleen de
# regels KEY=waarde lezen die merge.sh nodig heeft, met een vaste vorm.
CONF="$(dirname "$0")/lead.conf"
conf() { [ -f "$CONF" ] && sed -n "s/^$1=\([^[:space:]]*\)[[:space:]]*\$/\1/p" "$CONF" | head -n 1; }
CI_WORKFLOW=$(conf CI_WORKFLOW)
[ -n "$CI_WORKFLOW" ] || CI_WORKFLOW=CI
CI_WORKFLOW="${LAB_MERGE_CI_WORKFLOW:-$CI_WORKFLOW}"
[[ $CI_WORKFLOW =~ ^[A-Za-z0-9._-]+$ ]] || fout "ongeldige CI-workflownaam '$CI_WORKFLOW' (lead.conf of LAB_MERGE_CI_WORKFLOW)"
# De repo staat vast (lead.conf GH_REPO): gh kiest hem niet uit de map waarin het script draait.
REPO=$(conf GH_REPO)
[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fout "GH_REPO ontbreekt of is ongeldig in $CONF"

pr="" droog=0 contract="" spoor=""
while [ $# -gt 0 ]; do
  case $1 in
    --droog) droog=1 ;;
    --contract) [ $# -ge 2 ] || fout "--contract mist een bestand"; contract=$2; shift ;;
    --spoor) [ $# -ge 2 ] || fout "--spoor mist een id"; spoor=$2; shift ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    -*) fout "onbekende optie: $1" ;;
    *) [ -z "$pr" ] || fout "maar één PR-nummer"; pr=$1 ;;
  esac
  shift
done
[[ $pr =~ ^[0-9]+$ ]] || fout "geef een PR-nummer, bijvoorbeeld: merge.sh 71"
{ [ -z "$contract" ] && [ -z "$spoor" ]; } || { [ -n "$contract" ] && [ -n "$spoor" ]; } || fout "--contract en --spoor horen bij elkaar"
if [ -n "$contract" ]; then
  [ -f "$contract" ] || fout "contractbestand niet gevonden: $contract"
  [[ $spoor =~ ^[A-Za-z0-9]+$ ]] || fout "--spoor is een id zoals D2 of W1"
  # De Bezit:-regel in de sectie "## <spoor> ·" (tot de volgende "## "); paden = stukken tussen backticks.
  bezitregel=$(awk -v id="$spoor" '
    /^## / { insec = (index($0, "## " id " ") == 1); next }
    insec && /^Bezit:/ { print; exit }' "$contract")
  [ -n "$bezitregel" ] || fout "geen \"Bezit:\"-regel voor spoor $spoor in $contract"
  bezit=()
  while IFS= read -r t; do
    t=${t//\`/}
    # alleen padachtige stukken: tekens van een pad en een / of . erin; "stapE2e" en "<header>" vallen af
    if [[ $t =~ ^[A-Za-z0-9_.@*/-]+$ ]] && [[ $t == */* || $t == *.* ]]; then bezit+=("$t"); fi
  done < <(printf '%s\n' "$bezitregel" | grep -o '`[^`]*`' || true)
  [ "${#bezit[@]}" -gt 0 ] || fout "de Bezit:-regel van spoor $spoor noemt geen paden tussen backticks"
fi

json=$(gh pr view "$pr" --json state,headRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,comments,statusCheckRollup,files,changedFiles,commits --repo "$REPO") \
  || fout "PR $pr niet op te halen met gh"
j() { printf '%s' "$json" | jq -r "$1"; }

state=$(j '.state')
tak=$(j '.headRefName')
[ "$state" = OPEN ] || fout "PR $pr staat op $state, niet OPEN"
[ "$(j '.isCrossRepository')" = false ] || fout "PR $pr komt uit een fork (isCrossRepository)"
case $tak in main|master) fout "PR $pr heeft als tak '$tak'" ;; esac
[[ $tak =~ ^[A-Za-z0-9._/-]+$ && $tak != -* && $tak != *..* ]] || fout "PR $pr heeft een ongeldige taknaam '$tak'"
sha=$(j '.headRefOid[0:7]')
[[ $sha =~ ^[0-9a-f]{7}$ ]] || fout "kan het head-SHA van PR $pr niet lezen"
headvol=$(j '.headRefOid')
[[ $headvol =~ ^[0-9a-f]{40}$ ]] || fout "kan het volledige head-SHA van PR $pr niet lezen"

# Geen enkele CheckRun van de CI-workflow (lead.conf): GitHub startte soms geen CI bij een nieuwe PR (#85, #87, #88). Dat is
# iets anders dan "poort niet groen" of "poort ontbreekt": wachten helpt niet, de PR moet opnieuw een run krijgen.
# Vercel zet eigen entries in de rollup (StatusContext "Vercel", CheckRun "Vercel Preview Comments"); die tellen niet.
# Fail-closed: faalt jq of is de uitvoer geen getal, dan weigert merge.sh (geen CI-run overslaan).
ci_n=$(printf '%s' "$json" | jq -r --arg w "$CI_WORKFLOW" '[.statusCheckRollup[]? | select(.__typename == "CheckRun" and .workflowName == $w)] | length') || fout "kon de CI-runs niet uitlezen (jq faalde)"
[[ $ci_n =~ ^[0-9]+$ ]] || fout "kon de CI-runs niet uitlezen (onverwachte jq-uitvoer)"
if [ "$ci_n" -eq 0 ]; then
  fout "geen CI-run voor $sha; sluit en heropen de PR of push opnieuw"
fi

uitslag=$(printf '%s' "$json" | jq -r --arg c "$CHECK" '[.statusCheckRollup[]? | select((.name // .context) == $c)] | if length == 0 then "ontbreekt" else (sort_by(.startedAt // .completedAt // "") | last | (if (.conclusion // "") != "" then .conclusion else (.state // .status // "bezig") end)) end')
case $uitslag in
  SUCCESS|success) ;;
  ontbreekt) fout "de verplichte check '$CHECK' staat niet op PR $pr" ;;
  *) fout "de verplichte check '$CHECK' is niet groen (stand: $uitslag)" ;;
esac

mergeable=$(j '.mergeable')
[ "$mergeable" = MERGEABLE ] || fout "PR $pr is niet mergeable (stand: $mergeable)"
status=$(j '.mergeStateStatus')
case $status in
  CLEAN) ;;
  UNSTABLE) echo "merge: waarschuwing: mergeStateStatus is UNSTABLE (een niet-verplichte check is niet groen)" >&2 ;;
  BEHIND) fout "tak $tak loopt achter op main: eerst bijwerken (strict)" ;;
  *) fout "PR $pr kan nog niet mergen (mergeStateStatus: $status)" ;;
esac

# Bezitscheck: waarschuwing, geen weigering (de lead beslist).
if [ -n "$contract" ]; then
  buiten=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    binnen=0
    for b in "${bezit[@]}"; do
      case $b in
        */) [[ $f == "$b"* ]] && binnen=1 ;;
        *\**) [[ $f == $b || $f == */$b ]] && binnen=1 ;;
        *) [[ $f == "$b" || $f == */"$b" ]] && binnen=1 ;;
      esac
      [ "$binnen" = 1 ] && break
    done
    [ "$binnen" = 1 ] || buiten+=("$f")
  done < <(printf '%s' "$json" | jq -r '.files[]?.path')
  # gh geeft maximaal ~100 bestanden; is de lijst korter dan het echte aantal, dan is de check niet volledig
  totaal=$(j '.changedFiles // 0')
  gezien=$(j '[.files[]?] | length')
  if [ "$totaal" -gt "$gezien" ]; then
    echo "merge: waarschuwing: de bezitscheck zag $gezien van $totaal bestanden (gh kapt de lijst af); controleer de rest zelf" >&2
  fi
  if [ "${#buiten[@]}" -gt 0 ]; then
    echo "merge: waarschuwing: PR $pr raakt ${#buiten[@]} bestand(en) buiten het Bezit van spoor $spoor:" >&2
    printf 'merge:   %s\n' "${buiten[@]}" >&2
  else
    echo "merge: bezitscheck: alle bestanden van PR $pr vallen binnen het Bezit van spoor $spoor"
  fi
fi

if [ "$droog" = 1 ]; then
  echo "droog: PR $pr voldoet; zou draaien: gh pr merge $pr --merge --match-head-commit $headvol --repo $REPO, controleren op MERGED, open PR's met base $tak naar main zetten, dan gh api -X DELETE repos/$REPO/git/refs/heads/$tak"
  exit 0
fi

# --match-head-commit beschermt tegen een verschoven head tussen lezen en mergen.
gh pr merge "$pr" --merge --match-head-commit "$headvol" --repo "$REPO"
na=$(gh pr view "$pr" --json state --repo "$REPO" | jq -r '.state')
if [ "$na" != MERGED ]; then
  echo "merge: PR $pr staat na het mergen op '$na', niet MERGED; remote tak $tak blijft staan" >&2
  exit 1
fi
# Open PR's die op deze tak gebaseerd zijn eerst naar main: anders sluit GitHub ze bij het
# verwijderen van de tak (#245, #247). Lukt dat niet, dan blijft de tak staan.
limiet=1000
lijst=$(gh pr list --base "$tak" --state open --limit "$limiet" --json number --repo "$REPO") \
  || { echo "merge: PR $pr is gemerged, maar de PR's met base $tak zijn niet op te halen; remote tak $tak blijft staan" >&2; exit 1; }
printf '%s' "$lijst" | jq -e 'type == "array"' >/dev/null \
  || { echo "merge: PR $pr is gemerged, maar het antwoord over de PR's met base $tak is geen lijst (onleesbaar); remote tak $tak blijft staan" >&2; exit 1; }
aantal=$(printf '%s' "$lijst" | jq 'length') \
  || { echo "merge: PR $pr is gemerged, maar het antwoord over de PR's met base $tak is onleesbaar; remote tak $tak blijft staan" >&2; exit 1; }
[ "$aantal" -lt "$limiet" ] \
  || { echo "merge: PR $pr is gemerged, maar $aantal PR's met base $tak is de limiet: de lijst kan afgekapt zijn; remote tak $tak blijft staan" >&2; exit 1; }
verplaatst=""
for n in $(printf '%s' "$lijst" | jq -r '.[].number'); do
  gh pr edit "$n" --base main --repo "$REPO" \
    || { echo "merge: PR $pr is gemerged, maar PR $n (base $tak) kon niet naar main; al op main gezet:${verplaatst:- geen}; remote tak $tak blijft staan" >&2; exit 1; }
  verplaatst="$verplaatst #$n"
  echo "merge: PR $n had $tak als base, nu main"
done
# Via de API, niet via een lokale push: geen worktree-config, remote of pre-push-hook onder de allow-regel.
gh api -X DELETE "repos/$REPO/git/refs/heads/$tak" --silent \
  || { echo "merge: PR $pr is gemerged, maar remote tak $tak kon niet weg (gh api)" >&2; exit 1; }
echo "PR $pr gemerged; remote tak $tak verwijderd"
