#!/bin/sh
# Run from a checkout. Installs a copy; deleting the checkout is safe afterwards.
set -eu
RELAY_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
RELAY_BUN=$(command -v bun) || { echo 'Relay needs Bun >= 1.4.2 on PATH.' >&2; exit 1; }
unset BUN_OPTIONS NODE_OPTIONS
exec "$RELAY_BUN" --config=/dev/null --tsconfig-override=/dev/null --no-env-file --no-macros --no-install "$RELAY_SOURCE/bin/relay.ts" install "$@"
