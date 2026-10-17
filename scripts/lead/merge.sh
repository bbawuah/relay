#!/usr/bin/env bash
# Merge een PR als de lead-voorwaarden kloppen. Gebruik: scripts/lead/merge.sh <pr> [--droog]
# Weigert (exit 1, met reden) zonder "Lead-review: akkoord"-comment, zonder groene check
# 'poort', als de PR niet mergeable is of de tak achterloopt. Zie scripts/lead/README.md.
set -euo pipefail

CHECK="${LAB_MERGE_CHECK:-poort}"
# Workflownaam van de CI: één bron in lead.conf (ook voor wachtrij.ts), override met LAB_MERGE_CI_WORKFLOW.
fout() { echo "merge: geweigerd: $*" >&2; exit 1; }
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
# Alleen de lead merget: een gespawnde agent kan zelf "Lead-review: akkoord" posten, maar niet mergen.
# --droog (alleen controleren) mag zonder die rol.
[ "$droog" = 1 ] || [ "${LAB_AGENT_ROL:-}" = lead ] || fout "alleen de lead merget (LAB_AGENT_ROL=lead)"
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

json=$(gh pr view "$pr" --json state,headRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,comments,statusCheckRollup,files,changedFiles --repo "$REPO") \
  || fout "PR $pr niet op te halen met gh"
j() { printf '%s' "$json" | jq -r "$1"; }

state=$(j '.state')
tak=$(j '.headRefName')
[ "$state" = OPEN ] || fout "PR $pr staat op $state, niet OPEN"
[ "$(j '.isCrossRepository')" = false ] || fout "PR $pr komt uit een fork (isCrossRepository)"
case $tak in main|master) fout "PR $pr heeft als tak '$tak'" ;; esac
sha=$(j '.headRefOid[0:7]')
[[ $sha =~ ^[0-9a-f]{7}$ ]] || fout "kan het head-SHA van PR $pr niet lezen"
headvol=$(j '.headRefOid')
[[ $headvol =~ ^[0-9a-f]{40}$ ]] || fout "kan het volledige head-SHA van PR $pr niet lezen"

akkoord=$(printf '%s' "$json" | jq -r --arg s "$sha" '[.comments[]? | select(.body | test("^Lead-review: akkoord " + $s + "([^0-9a-fA-F]|$)"))] | length')
if [ "$akkoord" -lt 1 ]; then
  if [ "$(j '[.comments[]? | select(.body | startswith("Lead-review: akkoord"))] | length')" -ge 1 ]; then
    fout "push na akkoord: geen \"Lead-review: akkoord $sha\" voor de huidige head van PR $pr"
  fi
  fout "PR $pr heeft geen comment die begint met \"Lead-review: akkoord $sha\""
fi

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
  echo "droog: PR $pr voldoet; zou draaien: gh pr merge $pr --merge --match-head-commit $headvol --repo $REPO, controleren op MERGED, dan git push origin --delete $tak"
  exit 0
fi

# --match-head-commit: GitHub weigert als de head ondertussen is verschoven (een push tussen de
# akkoord-controle hierboven en het mergen); de head die tegen het akkoord is getoetst, telt.
gh pr merge "$pr" --merge --match-head-commit "$headvol" --repo "$REPO"
na=$(gh pr view "$pr" --json state --repo "$REPO" | jq -r '.state')
if [ "$na" != MERGED ]; then
  echo "merge: PR $pr staat na het mergen op '$na', niet MERGED; remote tak $tak blijft staan" >&2
  exit 1
fi
git push origin --delete "$tak"
echo "PR $pr gemerged; remote tak $tak verwijderd"
