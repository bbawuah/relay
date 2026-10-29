#!/bin/sh
':' //; RELAY_ENTRY=$0
':' //; while [ -L "$RELAY_ENTRY" ]; do
':' //;   RELAY_DIR=$(CDPATH= cd -- "$(dirname -- "$RELAY_ENTRY")" && pwd -P) || exit 1
':' //;   RELAY_LINK=$(readlink "$RELAY_ENTRY") || exit 1
':' //;   case $RELAY_LINK in /*) RELAY_ENTRY=$RELAY_LINK;; *) RELAY_ENTRY=$RELAY_DIR/$RELAY_LINK;; esac
':' //; done
':' //; RELAY_DIR=$(CDPATH= cd -- "$(dirname -- "$RELAY_ENTRY")" && pwd -P) || exit 1
':' //; unset BUN_OPTIONS NODE_OPTIONS
':' //; exec bun --config=/dev/null --tsconfig-override=/dev/null --no-env-file --no-macros --no-install "$RELAY_DIR/relay.ts" "$@"
// The shell lines above are string literals/comments to Bun. The executable
// package bin enters through sh, so isolation is in place before Bun starts.
import { main } from "../src/cli";

try {
  // Bus.klaar() drains wake-ups; its safety timers must not keep a CLI alive.
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`relay: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
