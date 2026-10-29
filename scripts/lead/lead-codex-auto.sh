#!/usr/bin/env bash
# Maakt de korte `relay codex`-route veilig: een lead mag nooit vanuit de
# hoofdcheckout draaien. Vanuit een hoofdcheckout maken we daarom één stabiele
# sibling-worktree; vanuit een bestaande linked worktree gebruiken we die.
set -euo pipefail

HIER=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
STARTER="$HIER/lead-codex.sh"

fout() { echo "relay codex: $*" >&2; exit 1; }

git_hard() {
  git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.ignoreSubmodules=all "$@"
}

MAP=$(git_hard -C "$PWD" rev-parse --show-toplevel 2>/dev/null) || fout "start binnen een git-worktree"
MAP=$(cd "$MAP" && pwd -P)
GIT_DIR=$(git_hard -C "$MAP" rev-parse --path-format=absolute --git-dir) || fout "geen git-worktree: $MAP"
GIT_COMMON=$(git_hard -C "$MAP" rev-parse --path-format=absolute --git-common-dir) || fout "geen git-worktree: $MAP"

if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
  BASIS=$(basename "$MAP")
  DOEL="$(dirname "$MAP")/${BASIS}-codex-lead"
  if [ -e "$DOEL" ]; then
    [ -d "$DOEL" ] || fout "$DOEL bestaat maar is geen map; niets overschreven"
    DOEL_DIR=$(git_hard -C "$DOEL" rev-parse --path-format=absolute --git-dir 2>/dev/null) || fout "$DOEL bestaat maar is geen git-worktree"
    DOEL_COMMON=$(git_hard -C "$DOEL" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || fout "$DOEL bestaat maar is geen git-worktree"
    [ "$DOEL_DIR" != "$DOEL_COMMON" ] || fout "$DOEL is de hoofdcheckout; niets overschreven"
    [ "$DOEL_COMMON" = "$GIT_COMMON" ] || fout "$DOEL hoort bij een andere repository; niets overschreven"
  elif git_hard -C "$MAP" show-ref --verify --quiet refs/heads/lead/codex; then
    git_hard -C "$MAP" worktree add "$DOEL" lead/codex
  else
    git_hard -C "$MAP" worktree add -b lead/codex "$DOEL" HEAD
  fi
  MAP="$DOEL"
fi

cd "$MAP"
exec bash "$STARTER" "$@"
