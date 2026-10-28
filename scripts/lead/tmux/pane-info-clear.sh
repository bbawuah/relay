#!/usr/bin/env bash
# SessionEnd: alleen Claude-specifieke velden weg; hook.ts beheert vendor/agent/naam.
[ -n "${TMUX_PANE:-}" ] || exit 0
for o in @claude_model @claude_ctx @claude_cost @agent_state; do tmux set -p -u -t "$TMUX_PANE" "$o" 2>/dev/null; done
exit 0
