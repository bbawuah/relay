#!/usr/bin/env bash
# Merge een PR als de lead-voorwaarden kloppen. Gebruik: scripts/lead/merge.sh <pr> [--droog]
# Weigert (exit 1, met reden) zonder "Lead-review: akkoord"-comment, zonder groene check
# 'poort', als de PR niet mergeable is of de tak achterloopt. Zie scripts/lead/README.md.
set -euo pipefail

CHECK="${LAB_MERGE_CHECK:-poort}"
fout() { echo "merge: geweigerd: $*" >&2; exit 1; }

pr="" droog=0
for a in "$@"; do
  case $a in
    --droog) droog=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    -*) fout "onbekende optie: $a" ;;
    *) [ -z "$pr" ] || fout "maar één PR-nummer"; pr=$a ;;
  esac
done
[[ $pr =~ ^[0-9]+$ ]] || fout "geef een PR-nummer, bijvoorbeeld: merge.sh 71"

json=$(gh pr view "$pr" --json state,headRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,comments,statusCheckRollup) \
  || fout "PR $pr niet op te halen met gh"
j() { printf '%s' "$json" | jq -r "$1"; }

state=$(j '.state')
tak=$(j '.headRefName')
[ "$state" = OPEN ] || fout "PR $pr staat op $state, niet OPEN"
[ "$(j '.isCrossRepository')" = false ] || fout "PR $pr komt uit een fork (isCrossRepository)"
case $tak in main|master) fout "PR $pr heeft als tak '$tak'" ;; esac
sha=$(j '.headRefOid[0:7]')
[[ $sha =~ ^[0-9a-f]{7}$ ]] || fout "kan het head-SHA van PR $pr niet lezen"

akkoord=$(printf '%s' "$json" | jq -r --arg s "$sha" '[.comments[]? | select(.body | test("^Lead-review: akkoord " + $s + "([^0-9a-fA-F]|$)"))] | length')
if [ "$akkoord" -lt 1 ]; then
  if [ "$(j '[.comments[]? | select(.body | startswith("Lead-review: akkoord"))] | length')" -ge 1 ]; then
    fout "push na akkoord: geen \"Lead-review: akkoord $sha\" voor de huidige head van PR $pr"
  fi
  fout "PR $pr heeft geen comment die begint met \"Lead-review: akkoord $sha\""
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

if [ "$droog" = 1 ]; then
  echo "droog: PR $pr voldoet; zou draaien: gh pr merge $pr --merge, controleren op MERGED, dan git push origin --delete $tak"
  exit 0
fi

gh pr merge "$pr" --merge
na=$(gh pr view "$pr" --json state | jq -r '.state')
if [ "$na" != MERGED ]; then
  echo "merge: PR $pr staat na het mergen op '$na', niet MERGED; remote tak $tak blijft staan" >&2
  exit 1
fi
git push origin --delete "$tak"
echo "PR $pr gemerged; remote tak $tak verwijderd"
