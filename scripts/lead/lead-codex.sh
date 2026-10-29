#!/usr/bin/env bash
# Optionele Codex-launcher met sessie-identiteit voor de peerbus; gebruikt het bestaande profiel.
# De identiteit is per checkout: de daemon/hooks erven geen TUI-omgeving.
set -euo pipefail

HIER=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
MAP=$(pwd -P)
WERKRUIMTE=${LAB_CODEX_LEAD_WERKRUIMTE:-"$MAP"}
WERKRUIMTE=$(cd "$WERKRUIMTE" && pwd -P)
THUIS=${HOME:?HOME ontbreekt}
STAAT=${LAB_LEAD_STAAT:-"$THUIS/.local/state/lab-lead"}
BUN=${LAB_LEAD_BUN:-bun}
CODEX=${LAB_LEAD_CODEX:-codex}
NAAM=${LAB_AGENT_NAAM:-codex-lead}

fout() { echo "lead-codex: $*" >&2; exit 1; }

[ -d "$MAP" ] || fout "werkmap ontbreekt: $MAP"
command -v "$BUN" >/dev/null 2>&1 || fout "bun ontbreekt"
command -v "$CODEX" >/dev/null 2>&1 || fout "codex ontbreekt"

IDENTITEIT_MAP="$STAAT/identiteit"
mkdir -p "$IDENTITEIT_MAP"
chmod 700 "$IDENTITEIT_MAP"
SLEUTEL=$(printf '%s' "$WERKRUIMTE" | shasum -a 256 | awk '{print substr($1, 1, 24)}')
IDENTITEIT="$IDENTITEIT_MAP/$SLEUTEL.json"
([ ! -e "$IDENTITEIT" ] && [ ! -L "$IDENTITEIT" ]) || fout "identiteit bestaat al: $IDENTITEIT; start niet in een gebruikte werkruimte"
SPAWN_ID="lead-$(date +%s)-$$"
TIJD=$(( $(date +%s) * 1000 ))
TMP=$(mktemp "$IDENTITEIT.XXXXXX")
cleanup() {
  rm -f "$TMP"
  [ -f "$IDENTITEIT" ] && [ "$(jq -r '.spawn_id // ""' "$IDENTITEIT" 2>/dev/null || true)" = "$SPAWN_ID" ] && rm -f "$IDENTITEIT"
}
trap cleanup EXIT HUP INT TERM

# Het bestaande compatibiliteitslabel blijft staan: geïnstalleerde guards kunnen
# deze metadata nog als bevoegdheid lezen. Geen rolverhoging door een bronreset.
jq -n --arg naam "$NAAM" --arg spawn_id "$SPAWN_ID" --argjson ts "$TIJD" \
  '{naam: $naam, rol: "lead-proef", lead: $naam, opdracht: "", spawn_id: $spawn_id, ts: $ts}' >"$TMP" ||
  fout "kon de identiteit niet schrijven"
chmod 600 "$TMP"
mv "$TMP" "$IDENTITEIT"

# Gebruik de bestaande Codex-configuratie en geef argumenten ongewijzigd door.
env LAB_AGENT_NAAM="$NAAM" LAB_AGENT_ROL=lead-proef LAB_LEAD_NAAM="$NAAM" LAB_LEAD_STAAT="$STAAT" LAB_SPAWN_ID="$SPAWN_ID" \
  "$CODEX" -C "$WERKRUIMTE" "$@"
