#!/bin/bash -p
# Push de huidige tak naar origin, of verwijder een gemergede remote tak. Gebruik:
#   scripts/lead/push.sh [--droog]                    huidige tak naar origin, met upstream
#   scripts/lead/push.sh --verwijder <tak> [--droog]  remote tak weg, alleen als hij in origin/main zit
# Weigert (exit 1, met reden) main/master, detached HEAD, elke force-vorm, een andere remote dan
# origin en een tak die (ook) in een andere worktree is uitgecheckt. Zie scripts/lead/README.md.
# Vangnet tegen vergissingen, geen grens (geen allow-regel): zie scripts/lead/README.md.
set -euo pipefail
unset BASH_ENV ENV

fout() { echo "push: geweigerd: $*" >&2; exit 1; }
# Als root-kopie in /usr/local/lib/lab-lead: vaste PATH.
if [ "$(cd "$(dirname "$0")" && pwd -P)" = /usr/local/lib/lab-lead ]; then
  PATH=/usr/bin:/bin:/opt/homebrew/bin
  export PATH
fi

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
    --no-verify) fout "--no-verify slaat de poort over; deze helper ondersteunt dat niet" ;;
    -*) fout "onbekende optie: $1" ;;
    +*) fout "force-push mag niet ($1: een refspec met +)" ;;
    *)
      [ -z "$remote" ] || fout "alleen een remote mag als argument (origin), geen refspec: $1"
      remote=$1 ;;
  esac
  shift
done
[ -z "$remote" ] || [ "$remote" = origin ] || fout "alleen naar remote 'origin', niet '$remote'"

# Geen config uit de omgeving (git -c via env): die kan core.hooksPath of een pushurl omzetten.
while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep -E '^GIT_CONFIG_(PARAMETERS|COUNT|KEY_[0-9]+|VALUE_[0-9]+)$' || true)

git rev-parse --git-dir >/dev/null 2>&1 || fout "geen git-repo in $(pwd)"
url=$(git remote get-url origin 2>/dev/null) || fout "deze repo heeft geen remote 'origin'"
pushurl=$(git remote get-url --push origin 2>/dev/null) || fout "kan de push-URL van origin niet lezen"
[ "$url" = "$pushurl" ] || fout "de push-URL van origin ($pushurl) wijkt af van de fetch-URL ($url)"
if git config --get-regexp '^url\..*\.pushinsteadof$' >/dev/null 2>&1; then
  fout "er staat een url.*.pushInsteadOf in de git-config; die stuurt een push naar een andere plek"
fi

# Gebruik de bestaande Git-configuratie en hooks; geen verplichte lokale hookinstallatie.
GIT=(git)

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
  # Bij GitHub (en gh beschikbaar) ook een gemergede PR van die tak eisen.
  rauw=$(git config --get remote.origin.url || true)
  if [[ $rauw =~ github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]] && command -v gh >/dev/null 2>&1; then
    repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
    n=$(gh pr list --repo "$repo" --head "$tak" --state merged --json number --jq length 2>/dev/null) \
      || fout "kan de PR's van '$tak' niet opvragen bij $repo (gh)"
    [[ $n =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] || fout "geen gemergede PR met tak '$tak' in $repo"
  fi
  # --force-with-lease als slot, geen force: verwijder alleen als de tak nog op de getoetste sha staat.
  if [ "$droog" = 1 ]; then
    echo "droog: zou draaien git push --force-with-lease=refs/heads/$tak:$sha origin --delete refs/heads/$tak"
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
  echo "droog: zou draaien git push -u origin refs/heads/$tak:refs/heads/$tak"
  exit 0
fi
"${GIT[@]}" push -u origin "refs/heads/$tak:refs/heads/$tak"
