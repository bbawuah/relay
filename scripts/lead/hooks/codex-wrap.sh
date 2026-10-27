#!/bin/sh
# Wrapper voor Codex-hooks: zet de identiteit van de sessie (uit <staat>/identiteit) in de omgeving van het commando (zie codex-wrap.ts).
# Gebruik: codex-wrap.sh <commando> [argumenten…]. Het commando draait altijd; zonder bun of zonder identiteit ongewijzigd.

[ "$#" -gt 0 ] || exit 0
STAAT=${LAB_LEAD_STAAT:-$HOME/.local/state/lab-lead}
if [ ! -d "$STAAT/identiteit" ]; then exec "$@"; fi

BUN=${LAB_LEAD_BUN:-}
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then BUN=$(command -v bun 2>/dev/null); fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then exec "$@"; fi
exec "$BUN" "$(dirname "$0")/codex-wrap.ts" "$@"
