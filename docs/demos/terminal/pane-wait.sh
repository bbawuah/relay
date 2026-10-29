#!/bin/sh
# Runs inside one tmux pane: waits for a start request, runs launch.sh, then waits again.
role=$1; D=$RELAY_DEMO_DIR; here=$(cd "$(dirname "$0")" && pwd)
touch "$D/proof/pane-$role.log"
printf '\033[2m[waiting] no process started yet\033[0m\n'
while :; do
  while [ ! -f "$D/proof/start-$role" ]; do sleep 0.3; done
  req=$(cat "$D/proof/start-$role"); rm -f "$D/proof/start-$role"
  set -- $req
  sh "$here/launch.sh" "$role" "$1" "$2"
done
