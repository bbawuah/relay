#!/bin/sh
# Wrapper voor Codex-hooks: zet de identiteit van de sessie (uit <staat>/identiteit) in de omgeving van het commando, en haalt zonder
# identiteitsbestand alle identiteitssleutels uit de omgeving (zie codex-wrap.ts).
# Gebruik: codex-wrap.sh <commando> [argumenten…].
# Optionele registratie: zonder bun stopt de wrapper zonder blokkade.

[ "$#" -gt 0 ] || exit 0

BUN=${LAB_LEAD_BUN:-}
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then BUN=$(command -v bun 2>/dev/null); fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "codex-wrap: bun niet gevonden; optionele sessieregistratie overgeslagen" >&2
  exit 0
fi
exec "$BUN" "$(dirname "$0")/codex-wrap.ts" "$@"
