#!/bin/sh
# Dunne wrapper: lead status. Opties: --json --alles --lead <n> --git (zie hooks/status.ts).
exec bun "$(dirname "$0")/hooks/status.ts" "$@"
