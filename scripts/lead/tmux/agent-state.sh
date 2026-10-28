#!/usr/bin/env bash
# Claude hook: status op de pane. @agent is exclusief eigendom van hook.ts.
[ -n "${TMUX_PANE:-}" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0
tmux set -p -t "$TMUX_PANE" @agent_state "${1:-idle}" 2>/dev/null || true
exit 0
