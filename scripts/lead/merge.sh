#!/bin/bash -p
# Merge een PR als de lead-voorwaarden kloppen. Gebruik: scripts/lead/merge.sh <pr> [--droog]
# Weigert (exit 1, met reden) zonder "Lead-review: akkoord"-comment, zonder groene check
# 'poort', als de PR niet mergeable is of de tak achterloopt, en zonder e2e-stempel van de
# volledige poort op de patch van de PR. Zie scripts/lead/README.md.
# Vangnet, geen grens: zie "Vangnet, geen grens" in scripts/lead/README.md.
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
# Alleen de gewone lead of Codex-lead-proef merget: een gespawnde agent kan zelf
# "Lead-review: akkoord" posten, maar niet mergen. --droog mag zonder die rol.
case ${LAB_AGENT_ROL:-} in
  lead|lead-proef) ;;
  *) [ "$droog" = 1 ] || fout "alleen de lead merget (LAB_AGENT_ROL=lead of lead-proef)" ;;
esac
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

# e2e-stempel: geen merge zonder een groene volledige poort (met de geraakte e2e) op de patch van
# deze PR. scripts/poort.ts schrijft na een groene run op een schone werkkopie
# ~/.cache/lab-bawuah/poort/<sha>.json. Een stempel op de head telt; een stempel op een oudere commit S
# van de PR telt als de eigen patch sindsdien gelijk is (git patch-id van main...S = van main...head),
# zodat update-branch de stempel niet ongeldig maakt. De combinatie met de nieuwere main toetst dit
# niet. Vangnet, geen grens: een agent kan het bestand zelf schrijven (zie scripts/lead/README.md).
STEMPELS="${LAB_MERGE_STEMPELS:-$HOME/.cache/lab-bawuah/poort}"
# compare <a> <b>: "status<TAB>merge-base" van GitHub (status: identical, ahead, behind, diverged)
compare() { gh api "repos/$REPO/compare/$1...$2" --jq '[.status, .merge_base_commit.sha] | @tsv'; }
# patch <s>: patch-id van de eigen wijziging van commit s t.o.v. main (leeg = geen of onleesbare patch)
patch() {
  local d
  d=$(gh api -H "Accept: application/vnd.github.diff" "repos/$REPO/compare/main...$1") || return 1
  printf '%s\n' "$d" | git patch-id --stable | cut -d' ' -f1
}
stempel="" stempel_reden=""
headpatch=""
# de head eerst, daarna de commits van de PR van nieuw naar oud
kandidaten=$(printf '%s' "$json" | jq -r '[.headRefOid] + ([.commits[]?.oid] | reverse) | reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end) | .[]') \
  || fout "kon de commits van PR $pr niet uitlezen (jq faalde)"
for s in $kandidaten; do
  [[ $s =~ ^[0-9a-f]{40}$ ]] || continue
  f="$STEMPELS/$s.json"
  { [ -f "$f" ] && [ ! -L "$f" ]; } || continue
  if ! jq -e --arg s "$s" '.sha == $s and .groen == true and (.modus == "alles" or (.modus == "affected" and ((.base // "") | test("^[0-9a-f]{40}$"))))' "$f" >/dev/null 2>&1; then
    stempel_reden="de stempel op ${s:0:7} is niet groen of onleesbaar (oud formaat zonder \"groen\": draai de poort opnieuw)"
    continue
  fi
  if [ "$(jq -r .modus "$f")" = affected ]; then
    # De basis van de stempel moet een voorouder zijn van de merge-base van main en S; anders telde
    # de poort te weinig als affected (bv. --base HEAD).
    sbase=$(jq -r .base "$f")
    mb=$(compare main "$s" | cut -f2) || fout "kon main...${s:0:7} niet vergelijken (gh api)"
    [[ $mb =~ ^[0-9a-f]{40}$ ]] || fout "onverwachte merge-base voor ${s:0:7} van gh api"
    st=$(compare "$sbase" "$mb" | cut -f1) || fout "kon de basis van de stempel niet vergelijken (gh api)"
    case $st in
      identical|ahead) ;;
      *) stempel_reden="de stempel op ${s:0:7} is gemaakt met een basis (${sbase:0:7}) die geen voorouder van main is; draai de poort met --base origin/main"; continue ;;
    esac
  fi
  if [ "$s" != "$headvol" ]; then
    [ -n "$headpatch" ] || headpatch=$(patch "$headvol") || fout "kon de patch van de head niet ophalen (gh api)"
    [ -n "$headpatch" ] || fout "de patch van PR $pr is leeg of onleesbaar"
    spatch=$(patch "$s") || fout "kon de patch van ${s:0:7} niet ophalen (gh api)"
    if [ "$spatch" != "$headpatch" ]; then
      stempel_reden="de patch is gewijzigd na de stempel op ${s:0:7}: draai de poort opnieuw op de head"
      continue
    fi
  fi
  stempel=$s
  break
done
if [ -z "$stempel" ]; then
  [ -n "$stempel_reden" ] && fout "geen geldige e2e-stempel voor PR $pr: $stempel_reden"
  fout "geen e2e-stempel voor PR $pr: draai \`bun run poort\` (met e2e) op een schone werkkopie van de tak"
fi
if [ "$stempel" = "$headvol" ]; then
  echo "merge: e2e-stempel op de head ${stempel:0:7} ($(jq -r .modus "$STEMPELS/$stempel.json"), $(jq -r .tijd "$STEMPELS/$stempel.json"))"
else
  echo "merge: e2e-stempel op ${stempel:0:7} ($(jq -r .modus "$STEMPELS/$stempel.json"), $(jq -r .tijd "$STEMPELS/$stempel.json")); patch van de head ${sha} is gelijk"
fi
# Optioneel stempelveld "overgeslagen" (poort.ts): stappen die lokaal niet draaiden omdat de diff ze niet raakte.
overgeslagen=$(jq -r '(.overgeslagen // []) | join(", ")' "$STEMPELS/$stempel.json" 2>/dev/null || true)
[ -z "$overgeslagen" ] || echo "merge: LET OP, in de poortrun overgeslagen: $overgeslagen (CI draait ze wel)"

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
  echo "droog: PR $pr voldoet (e2e-stempel ${stempel:0:7}); zou draaien: gh pr merge $pr --merge --match-head-commit $headvol --repo $REPO, controleren op MERGED, open PR's met base $tak naar main zetten, dan gh api -X DELETE repos/$REPO/git/refs/heads/$tak"
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
