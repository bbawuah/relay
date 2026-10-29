#!/bin/sh
# Wrapper voor Codex-hooks: zet de identiteit van de sessie (uit <staat>/identiteit) in de omgeving van het commando, en haalt zonder
# identiteitsbestand alle identiteitssleutels uit de omgeving (zie codex-wrap.ts).
# Gebruik: codex-wrap.sh <commando> [argumenten…].
# Zonder bun kan dat niet: bij PreToolUse faalt de wrapper dan luid (exit 2, de tool-aanroep wordt geweigerd, want grenzen.sh zou zonder
# rol draaien); bij andere events doet hij niets (exit 0).

[ "$#" -gt 0 ] || exit 0

BUN=${LAB_LEAD_BUN:-}
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then BUN=$(command -v bun 2>/dev/null); fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  invoer=$(cat)
  case $invoer in
    *'"hook_event_name":"PreToolUse"'* | *'"hook_event_name": "PreToolUse"'*)
      echo "codex-wrap: bun niet gevonden (LAB_LEAD_BUN=${LAB_LEAD_BUN:-}); de grenzen kunnen niet draaien, dus deze tool-aanroep is geweigerd. Draai codex-installeer.ts opnieuw." >&2
      exit 2 ;;
  esac
  exit 0
fi
unset BUN_OPTIONS NODE_OPTIONS
exec "$BUN" --config=/dev/null --tsconfig-override=/dev/null --no-env-file --no-macros --no-install "$(dirname "$0")/codex-wrap.ts" "$@"
