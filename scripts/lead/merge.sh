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

json=$(gh pr view "$pr" --json state,headRefName,mergeable,mergeStateStatus,comments,statusCheckRollup) \
  || fout "PR $pr niet op te halen met gh"
j() { printf '%s' "$json" | jq -r "$1"; }

state=$(j '.state')
tak=$(j '.headRefName')
[ "$state" = OPEN ] || fout "PR $pr staat op $state, niet OPEN"

akkoord=$(j '[.comments[]? | select(.body | startswith("Lead-review: akkoord"))] | length')
[ "$akkoord" -ge 1 ] || fout "PR $pr heeft geen comment die begint met \"Lead-review: akkoord\""

uitslag=$(printf '%s' "$json" | jq -r --arg c "$CHECK" '[.statusCheckRollup[]? | select((.name // .context) == $c)] | if length == 0 then "ontbreekt" else (.[-1] | (.conclusion // .state // "bezig")) end')
case $uitslag in
  SUCCESS|success) ;;
  ontbreekt) fout "de verplichte check '$CHECK' staat niet op PR $pr" ;;
  *) fout "de verplichte check '$CHECK' is niet groen (stand: $uitslag)" ;;
esac

mergeable=$(j '.mergeable')
[ "$mergeable" = MERGEABLE ] || fout "PR $pr is niet mergeable (stand: $mergeable)"
status=$(j '.mergeStateStatus')
case $status in
  BEHIND) fout "tak $tak loopt achter op main: eerst bijwerken (strict)" ;;
  DIRTY|BLOCKED|DRAFT|UNKNOWN) fout "PR $pr kan nog niet mergen (mergeStateStatus: $status)" ;;
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
