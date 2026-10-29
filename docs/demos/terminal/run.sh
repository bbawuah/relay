#!/bin/bash
# Four-pane Relay demo with direct native CLIs in an owned tmux server. No T3, no scripted agents.
#   run.sh --preview   build the private env + 4 titled panes, capture one frame, NO model process
#   run.sh             full run: 3 sequenced native sessions (max 2 live), each CLI bounded to 240 s
# Fail-closed: the full run refuses to start a model if the CLAUDECODE nesting marker is present in this
# environment. Nothing is unset, overridden or stripped; start it from a normal terminal instead.
set -u
here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-run}
if [ "$mode" != --preview ]; then
  if [ -n "${CLAUDECODE+x}" ]; then
    echo "refusing: CLAUDECODE marker present in this environment; no model started. Run from a normal terminal." >&2; exit 3
  fi
  for c in claude codex; do command -v $c >/dev/null || { echo "missing: $c" >&2; exit 4; }; done
fi
for c in tmux bun perl python3; do command -v $c >/dev/null || { echo "missing: $c" >&2; exit 4; }; done
D=$("$here/setup.sh") || exit 5
export RELAY_DEMO_DIR=$D
SOCK=$D/tmux.sock; P=$D/proof
tm() { env -u TMUX -u TMUX_PANE tmux -f /dev/null -S "$SOCK" "$@"; }
now() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
cleanup() { touch "$P/stop-capture"; sleep 0.6; tm kill-server 2>/dev/null; echo "owned tmux server on $SOCK stopped"; }
trap cleanup EXIT
echo "$D" > /private/tmp/relay-h6-run-dir.txt

# one window, four panes: TL claude-parent, TR codex-parent, BL claude-sub, BR codex-sub
tm new-session -d -s relaydemo -x 164 -y 44 -n demo "sh $here/pane-wait.sh claude-parent" || exit 6
tm set-option -t relaydemo -g pane-border-status top
tm set-option -t relaydemo -g pane-border-format ' #{pane_title} '
TL=$(tm list-panes -t relaydemo -F '#{pane_id}')
TR=$(tm split-window -h -t "$TL" -P -F '#{pane_id}' "sh $here/pane-wait.sh codex-parent")
BL=$(tm split-window -v -t "$TL" -P -F '#{pane_id}' "sh $here/pane-wait.sh claude-sub")
BR=$(tm split-window -v -t "$TR" -P -F '#{pane_id}' "sh $here/pane-wait.sh codex-sub")
tm select-pane -t "$TL" -T "Claude parent"; tm select-pane -t "$TR" -T "Codex parent"
tm select-pane -t "$BL" -T "Claude subagent"; tm select-pane -t "$BR" -T "Codex subagent"
bun "$here/capture.ts" "$SOCK" "$TL,$TR,$BL,$BR" "$P/frames.jsonl" "$P/stop-capture" &
printf '{"t":%s,"kind":"meta","mode":"%s"}\n' "$(now)" "$mode" >> "$P/events.jsonl"
sleep 1.5
if [ "$mode" = --preview ]; then sleep 1; echo "preview frames: $P/frames.jsonl"; exit 0; fi

wait_exit() { # role session timeout-seconds
  local n=0; while [ ! -f "$P/exit-$1-$2" ] && [ $n -lt $(( $3 * 4 )) ]; do sleep 0.25; n=$((n+1)); done
  [ -f "$P/exit-$1-$2" ] || echo "no exit marker for $1/$2 within $3 s" >&2
}
start() { printf '%s shell-runner\n' "$2" > "$P/start-$1.tmp" && mv "$P/start-$1.tmp" "$P/start-$1"; }
# 1. Claude parent; it starts its own helper in the lower-left pane (max 2 live)
start claude-parent main; wait_exit claude-parent main 260; wait_exit claude-sub main 260
# 2. Codex parent; it starts its own helper in the lower-right pane
start codex-parent main; wait_exit codex-parent main 260; wait_exit codex-sub main 260
# 3. Short second Claude parent session: reads and acknowledges the final review
start claude-parent review; wait_exit claude-parent review 260
sleep 2
echo "run finished: $D"
