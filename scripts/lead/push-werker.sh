#!/usr/bin/env bash
# Pusht het werk van een Codex-werker zonder netwerk (de werker meldt "klaar om te pushen op <sha>").
# Gebruik: LAB_AGENT_ROL=lead scripts/lead/push-werker.sh [--droog] <worktree-van-de-werker> <sha> <tak>
# Alleen voor de lead, vanuit zijn eigen checkout, nooit met de cwd in de worktree van een werker.
# Besluit Brian 27 okt 2026 (#683, optie a): de lead pusht zonder lokale pre-push-poort, want die poort draait `bun run check` in de
# checkout en dat zou ongereviewde werkercode buiten de sandbox uitvoeren. De poort is CI-check `poort`; de lead draait de volledige
# poort vóór de merge, na review.
# Toetst: rol lead; <tak> is niet main/master en is de tak van <worktree> volgens `git worktree list --porcelain` van de lead (er
# draait geen git in de werker-worktree: zijn .git/config is niet te vertrouwen); <sha> is precies de HEAD daarvan (de gemelde sha);
# <sha> is een fast-forward van origin/<tak> (of de tak is nieuw). Pusht met `origin <sha>:refs/heads/<tak>`, zonder hooks en
# fsmonitor, zonder GIT_*-variabelen, nooit met --force.
set -euo pipefail

fout() { echo "push-werker: $*" >&2; exit 1; }
droog=0
if [ "${1:-}" = "--droog" ]; then droog=1; shift; fi
[ $# -eq 3 ] || fout "gebruik: LAB_AGENT_ROL=lead push-werker.sh [--droog] <worktree> <sha> <tak>"
wt=$1 sha=$2 tak=$3
[ "${LAB_AGENT_ROL:-}" = lead ] || fout "weigert: alleen de lead (LAB_AGENT_ROL=lead) pusht werkertakken"

# Veilige git: geen hooks, geen fsmonitor, geen GIT_*.
git_veilig() (
  while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep '^GIT_' || true)
  git -c core.hooksPath=/dev/null -c core.fsmonitor= "$@"
)

STAAT="${LAB_LEAD_STAAT:-$HOME/.local/state/lab-lead}"
[ -d "$wt" ] || fout "worktree bestaat niet: $wt"
wt=$(cd "$wt" && pwd -P)
hier=$(git_veilig rev-parse --show-toplevel 2>/dev/null) || fout "niet in een git-checkout"
hier=$(cd "$hier" && pwd -P)

# Nooit vanuit de worktree van een werker.
[ "$hier" != "$wt" ] || fout "weigert: dit draait in de worktree van de werker ($wt). Draai het vanuit je eigen checkout"
hash=$(printf '%s' "$hier" | shasum -a 256 | cut -c1-24)
[ ! -e "$STAAT/identiteit/$hash.json" ] || fout "weigert: $hier is de worktree van een werker (identiteit $STAAT/identiteit/$hash.json). Draai het vanuit je eigen checkout"

[[ $sha =~ ^[0-9a-f]{40}$ ]] || fout "geef de volledige sha (40 tekens), niet '$sha'"
git_veilig check-ref-format --branch "$tak" >/dev/null 2>&1 || fout "ongeldige tak: $tak"
case $tak in main|master|HEAD|-*) fout "weigert: $tak is niet toegestaan als doel" ;; esac

# De tak en HEAD van de werker uit de lijst van de lead (git leest daar de administratie in de gedeelde .git, niet de worktree).
lijst_pad="" lijst_kop="" lijst_tak="" gevonden=0 gevonden_kop="" gevonden_tak=""
while IFS= read -r regel; do
  case $regel in
    "worktree "*) lijst_pad=$(cd "${regel#worktree }" 2>/dev/null && pwd -P || true); lijst_kop="" lijst_tak="" ;;
    "HEAD "*) lijst_kop=${regel#HEAD } ;;
    "branch "*) lijst_tak=${regel#branch refs/heads/} ;;
    "")
      if [ "$lijst_pad" = "$wt" ]; then gevonden_kop=$lijst_kop gevonden_tak=$lijst_tak gevonden=1; fi ;;
  esac
done < <(git_veilig worktree list --porcelain; echo)
[ "$gevonden" = 1 ] || fout "weigert: $wt is geen worktree van deze repo (git worktree list)"
[ -n "$gevonden_tak" ] || fout "weigert: de worktree $wt heeft geen tak (losse HEAD)"
[ "$gevonden_tak" = "$tak" ] || fout "weigert: de tak van $wt is '$gevonden_tak', niet '$tak'"
[ "$gevonden_kop" = "$sha" ] || fout "weigert: HEAD van de werker is $gevonden_kop, niet de gemelde $sha (de werker is doorgewerkt of de sha klopt niet)"

# Fast-forward van de tak op origin (of nieuw).
if git_veilig ls-remote --exit-code --heads origin "refs/heads/$tak" >/dev/null 2>&1; then
  git_veilig fetch -q origin "refs/heads/$tak" || fout "kon origin/$tak niet ophalen"
  rem=$(git_veilig rev-parse FETCH_HEAD)
  git_veilig merge-base --is-ancestor "$rem" "$sha" || fout "weigert: $sha is geen fast-forward van origin/$tak ($rem); geen force-push"
fi

echo "push-werker: let op: de lokale pre-push-poort wordt bewust overgeslagen (uitzondering, Brian 27 okt 2026: geen ongereviewde werkercode buiten de sandbox). CI-check 'poort' is de poort; draai de volledige poort vóór de merge." >&2
if [ "$droog" = 1 ]; then echo "droog: git push origin $sha:refs/heads/$tak (vanuit $hier)"; exit 0; fi
git_veilig push origin "$sha:refs/heads/$tak"
