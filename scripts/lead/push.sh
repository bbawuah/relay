#!/usr/bin/env bash
# Push de huidige tak naar origin, of verwijder een gemergede remote tak. Gebruik:
#   scripts/lead/push.sh [--droog]                    huidige tak naar origin, met upstream
#   scripts/lead/push.sh --verwijder <tak> [--droog]  remote tak weg, alleen als hij in origin/main zit
# Weigert (exit 1, met reden) main/master, detached HEAD, elke force-vorm, een andere remote dan
# origin en een tak die (ook) in een andere worktree is uitgecheckt. Zie scripts/lead/README.md.
set -euo pipefail

fout() { echo "push: geweigerd: $*" >&2; exit 1; }

# Een taknaam: alleen deze tekens, niet met - of / beginnen, geen .., geen glob (* ? [), geen + of :.
geldige_tak() {
  [[ $1 =~ ^[A-Za-z0-9._/-]+$ ]] && [[ $1 != -* && $1 != /* && $1 != */ && $1 != *..* && $1 != *//* ]] \
    && git check-ref-format "refs/heads/$1"
}

droog=0 verwijder="" remote=""
while [ $# -gt 0 ]; do
  case $1 in
    --droog) droog=1 ;;
    --verwijder) [ $# -ge 2 ] || fout "--verwijder mist een taknaam"; [ -z "$verwijder" ] || fout "maar één --verwijder"; verwijder=$2; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    -f|--force|--force=*|--force-with-lease|--force-with-lease=*|--force-if-includes|--mirror|-[!-]*f*)
      fout "force-push mag niet (optie $1); herschrijf geen gedeelde geschiedenis" ;;
    --delete|-d) fout "verwijderen gaat met --verwijder <tak> (alleen een gemergede tak)" ;;
    --no-verify) fout "--no-verify slaat de poort over; dat mag alleen Brian" ;;
    -*) fout "onbekende optie: $1" ;;
    +*) fout "force-push mag niet ($1: een refspec met +)" ;;
    *)
      [ -z "$remote" ] || fout "alleen een remote mag als argument (origin), geen refspec: $1"
      remote=$1 ;;
  esac
  shift
done
[ -z "$remote" ] || [ "$remote" = origin ] || fout "alleen naar remote 'origin', niet '$remote'"

git rev-parse --git-dir >/dev/null 2>&1 || fout "geen git-repo in $(pwd)"
git remote get-url origin >/dev/null 2>&1 || fout "deze repo heeft geen remote 'origin'"

# Nooit POORT_OVERSLAAN doorgeven: de pre-push-hook draait gewoon.
GIT=(env -u POORT_OVERSLAAN git)

if [ -n "$verwijder" ]; then
  tak=$verwijder
  geldige_tak "$tak" || fout "ongeldige taknaam '$tak' (exacte naam, geen glob)"
  case $tak in main|master) fout "tak '$tak' verwijder je nooit" ;; esac
  # Vers ophalen: de controle hieronder moet op de echte stand van origin draaien.
  "${GIT[@]}" fetch -q origin "+refs/heads/main:refs/remotes/origin/main" 2>/dev/null \
    || fout "kan origin/main niet ophalen"
  "${GIT[@]}" fetch -q origin "+refs/heads/$tak:refs/remotes/origin/$tak" 2>/dev/null \
    || fout "tak '$tak' bestaat niet op origin"
  sha=$(git rev-parse --verify -q "refs/remotes/origin/$tak^{commit}") || fout "kan origin/$tak niet lezen"
  git merge-base --is-ancestor "$sha" refs/remotes/origin/main \
    || fout "origin/$tak (${sha:0:7}) zit niet in origin/main; eerst mergen"
  # --force-with-lease als slot, geen force: verwijder alleen als de tak nog op de getoetste sha staat.
  if [ "$droog" = 1 ]; then
    echo "droog: zou draaien: git push --force-with-lease=refs/heads/$tak:$sha origin --delete refs/heads/$tak"
    exit 0
  fi
  "${GIT[@]}" push --force-with-lease="refs/heads/$tak:$sha" origin --delete "refs/heads/$tak"
  echo "push: remote tak $tak (${sha:0:7}, gemerged in origin/main) verwijderd"
  exit 0
fi

tak=$(git symbolic-ref --short -q HEAD) || fout "detached HEAD: check eerst een tak uit"
case $tak in main|master) fout "naar '$tak' gaat alles via een PR; push een eigen tak" ;; esac
geldige_tak "$tak" || fout "ongeldige taknaam '$tak'"

# De tak moet alleen in deze worktree uitgecheckt zijn.
hier=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
while IFS= read -r pad; do
  [ -n "$pad" ] || continue
  echt=$(cd "$pad" 2>/dev/null && pwd -P) || echt=$pad
  [ "$echt" = "$hier" ] || fout "tak '$tak' is (ook) uitgecheckt in een andere worktree: $pad"
done < <(git worktree list --porcelain | awk -v ref="refs/heads/$tak" '
  /^worktree / { wt = substr($0, 10) }
  $0 == "branch " ref { print wt }')

# Expliciete refspec: push.default, remote.origin.push of een upstream naar main spelen geen rol.
if [ "$droog" = 1 ]; then
  echo "droog: zou draaien: git push -u origin refs/heads/$tak:refs/heads/$tak"
  exit 0
fi
"${GIT[@]}" push -u origin "refs/heads/$tak:refs/heads/$tak"
