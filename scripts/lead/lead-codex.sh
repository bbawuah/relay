#!/usr/bin/env bash
# Start de Codex-lead met de vooraf goedgekeurde, eigen CODEX_HOME.
# De identiteit is per checkout: de daemon/hooks erven geen TUI-omgeving.
set -euo pipefail

HIER=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
MAP=$(pwd -P)
WERKRUIMTE=${LAB_CODEX_LEAD_WERKRUIMTE:-"$(dirname "$MAP")"}
WERKRUIMTE=$(cd "$WERKRUIMTE" && pwd -P)
THUIS=${HOME:?HOME ontbreekt}
STAAT=${LAB_LEAD_STAAT:-"$THUIS/.local/state/lab-lead"}
CODEX_HOME_LEAD="$THUIS/.codex-lead"
BUN=${LAB_LEAD_BUN:-bun}
CODEX=${LAB_LEAD_CODEX:-codex}
NAAM=${LAB_AGENT_NAAM:-codex-lead}

fout() { echo "lead-codex: $*" >&2; exit 1; }

[ "$NAAM" = "codex-lead" ] || fout "LAB_AGENT_NAAM moet codex-lead zijn"
[ -d "$MAP" ] || fout "werkmap ontbreekt: $MAP"
command -v "$BUN" >/dev/null 2>&1 || fout "bun ontbreekt"
command -v "$CODEX" >/dev/null 2>&1 || fout "codex ontbreekt"

# De starter heeft precies één vrije invoer: een gewone prompt. Alle Codex-vlaggen
# (ook -C/--cd en --add-dir) zouden de gecontroleerde cwd of het profiel omzeilen.
[ "$#" -le 1 ] || fout "alleen één prompt is toegestaan; Codex-vlaggen zijn niet toegestaan"
if [ "$#" = 1 ]; then
  case $1 in
    -*) fout "alleen één prompt is toegestaan; Codex-vlaggen zijn niet toegestaan" ;;
  esac
fi

git_hard() {
  git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.ignoreSubmodules=all -C "$MAP" "$@"
}

# Een lead-proef mag alleen vanuit een linked worktree starten, nooit de hoofdcheckout.
GIT_DIR=$(git_hard rev-parse --path-format=absolute --git-dir 2>/dev/null) || fout "geen git-worktree: $MAP"
GIT_COMMON=$(git_hard rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || fout "geen git-worktree: $MAP"
[ "$GIT_DIR" != "$GIT_COMMON" ] || fout "weiger de hoofdcheckout; start vanuit een eigen linked worktree"

"$BUN" "$HIER/hooks/codex-controle.ts" "$CODEX_HOME_LEAD/config.toml" ||
  fout "het profiel in $CODEX_HOME_LEAD is niet bruikbaar; draai: $BUN $HIER/hooks/codex-installeer.ts --codex-home $CODEX_HOME_LEAD --doel $CODEX_HOME_LEAD/hooks/lab-lead-hooks"
CODEX_HOME="$CODEX_HOME_LEAD" "$CODEX" login status >/dev/null 2>&1 ||
  fout "geen Codex-inlog in $CODEX_HOME_LEAD; Brian moet eerst CODEX_HOME=$CODEX_HOME_LEAD codex login draaien"

IDENTITEIT_MAP="$STAAT/identiteit"
mkdir -p "$IDENTITEIT_MAP"
chmod 700 "$IDENTITEIT_MAP"
SLEUTEL=$(printf '%s' "$WERKRUIMTE" | shasum -a 256 | awk '{print substr($1, 1, 24)}')
IDENTITEIT="$IDENTITEIT_MAP/$SLEUTEL.json"
([ ! -e "$IDENTITEIT" ] && [ ! -L "$IDENTITEIT" ]) || fout "identiteit bestaat al: $IDENTITEIT; start niet in een gebruikte werkruimte"
SPAWN_ID="lead-proef-$(date +%s)-$$"
TIJD=$(( $(date +%s) * 1000 ))
TMP=$(mktemp "$IDENTITEIT.XXXXXX")
cleanup() {
  rm -f "$TMP"
  [ -f "$IDENTITEIT" ] && [ "$(jq -r '.spawn_id // ""' "$IDENTITEIT" 2>/dev/null || true)" = "$SPAWN_ID" ] && rm -f "$IDENTITEIT"
}
trap cleanup EXIT HUP INT TERM

jq -n --arg naam "$NAAM" --arg spawn_id "$SPAWN_ID" --argjson ts "$TIJD" \
  '{naam: $naam, rol: "lead-proef", lead: $naam, opdracht: "", spawn_id: $spawn_id, ts: $ts}' >"$TMP" ||
  fout "kon de identiteit niet schrijven"
chmod 600 "$TMP"
mv "$TMP" "$IDENTITEIT"

# Geen -c, --sandbox of approval-vlag: config.toml is de vooraf beoordeelde beleidsbron.
env CODEX_HOME="$CODEX_HOME_LEAD" LAB_AGENT_NAAM="$NAAM" LAB_AGENT_ROL=lead-proef LAB_LEAD_NAAM="$NAAM" LAB_LEAD_STAAT="$STAAT" LAB_SPAWN_ID="$SPAWN_ID" \
  "$CODEX" -C "$WERKRUIMTE" "$@"
