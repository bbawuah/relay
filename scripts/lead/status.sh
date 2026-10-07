#!/bin/sh
# Dunne wrapper: lead status. Opties: --json --alles --lead <n> --git (zie hooks/status.ts).
# Bun: LAB_LEAD_BUN als hij uitvoerbaar is, anders `command -v bun`. Ontbreekt bun, dan staat de reden op stderr
# (exit 127); stdout blijft dan leeg en is dus nooit half-JSON.
BUN=${LAB_LEAD_BUN:-}
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  BUN=$(command -v bun 2>/dev/null)
fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "status.sh: bun niet gevonden (zet LAB_LEAD_BUN of zorg dat bun in PATH staat)" >&2
  exit 127
fi
exec "$BUN" "$(dirname "$0")/hooks/status.ts" "$@"
