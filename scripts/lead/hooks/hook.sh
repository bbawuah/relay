#!/bin/sh
# Wrapper voor de lead-hooks. Gebruik: hook.sh [wekker]  (het event staat anders in de stdin-JSON).
#
# - Lege LAB_AGENT_ROL (gw-sessies, losse sessies): meteen exit 0, bun wordt niet gestart.
# - Bun: env LAB_LEAD_BUN (de installer vult het in), anders `command -v bun`; ontbreekt hij: exit 0.
# - Alleen exit 2 (gate H6/H7, wekker H11) wordt doorgegeven, met de stderr van de hook.
#   Elke andere fout geeft exit 0 zonder uitvoer. De bewuste JSON-uitvoer (stdout) gaat door.

[ -z "$LAB_AGENT_ROL" ] && exit 0

BUN=${LAB_LEAD_BUN:-}
[ -z "$BUN" ] && BUN=$(command -v bun 2>/dev/null)
[ -z "$BUN" ] && exit 0
[ -x "$BUN" ] || exit 0

HERE=$(dirname "$0")

exec 3>&1
err=$("$BUN" "$HERE/hook.ts" "$@" 2>&1 1>&3 3>&-)
rc=$?
exec 3>&-

if [ "$rc" -eq 2 ]; then
  [ -n "$err" ] && printf '%s\n' "$err" >&2
  exit 2
fi
exit 0
