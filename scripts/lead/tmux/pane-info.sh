#!/usr/bin/env bash
# Claude statusLine: model/context/kosten op de huidige pane voor vendor.conf.
set -uo pipefail

in="$(cat)"
IFS=$'\037' read -r model pct used size cost < <(jq -r '
  def ctxsize: if (.model.id // "" | test("\\[1m\\]")) then 1000000 else 200000 end;
  (.context_window // {}) as $c
  | ($c.context_window_size // ctxsize) as $size
  | ($c.current_usage // null) as $u
  | (if $u then (($u.input_tokens // 0) + ($u.cache_creation_input_tokens // 0) + ($u.cache_read_input_tokens // 0)) else null end) as $used
  | ($c.used_percentage // (if $used then ($used / $size * 100) else null end)) as $pct
  | [(.model.display_name // .model.id // "?"), (if $pct then ($pct | round | tostring) else "" end), (if $used then ($used | tostring) else "" end), ($size | tostring), (.cost.total_cost_usd // "" | tostring)] | join("\u001f")' <<<"$in")
if [ -z "$pct" ]; then
  tp="$(jq -r '.transcript_path // empty' <<<"$in")"
  if [ -n "$tp" ] && [ -f "$tp" ]; then
    used="$(tail -n 200 "$tp" | jq -rs '[ .[] | select(.type == "assistant" and .message.usage and (.isSidechain | not)) | .message.usage ] | last | if . then ((.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)) else empty end' 2>/dev/null)"
    [ -n "$used" ] && pct=$(( used * 100 / size ))
  fi
fi
ctx=""
if [ -n "$pct" ]; then
  if [ "$pct" -ge 80 ]; then col="#f38ba8"; elif [ "$pct" -ge 50 ]; then col="#f9e2af"; else col="#a6e3a1"; fi
  ctx="#[fg=$col]ctx ${pct}%"
  [ -n "$used" ] && ctx="$ctx #[fg=#6c7086]($(( used / 1000 ))k/$(( size / 1000 ))k)"
fi
cost_fmt=""; [ -n "$cost" ] && cost_fmt="$(LC_NUMERIC=C printf '$%.2f' "$cost")"
if [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
  tmux set -p -t "$TMUX_PANE" @claude_model "$model" \; set -p -t "$TMUX_PANE" @claude_ctx "$ctx" \; set -p -t "$TMUX_PANE" @claude_cost "$cost_fmt" 2>/dev/null || true
fi

# Abonnementslimieten zijn accountbreed en blijven daarom in de statusbalk.
IFS=$'\037' read -r p5 r5 p7 r7 < <(jq -r '
  [(.rate_limits.five_hour.used_percentage // "" | tostring), (.rate_limits.five_hour.resets_at // "" | tostring), (.rate_limits.seven_day.used_percentage // "" | tostring), (.rate_limits.seven_day.resets_at // "" | tostring)] | join("\u001f")' <<<"$in")
limcol() { if [ "$1" -ge 80 ]; then echo "#f38ba8"; elif [ "$1" -ge 50 ]; then echo "#f9e2af"; else echo "#a6e3a1"; fi; }
lim=""
[ -n "$p5" ] && lim="#[fg=#6c7086]5u #[fg=$(limcol "$p5")]${p5}%#[fg=#6c7086]${r5:+ ↻$(date -r "$r5" +%H:%M)} "
[ -n "$p7" ] && lim="$lim#[fg=#6c7086]week #[fg=$(limcol "$p7")]${p7}%#[fg=#6c7086]${r7:+ ↻$(date -r "$r7" '+%a %H:%M')} "
if [ -n "$lim" ] && [ -n "${TMUX:-}" ]; then tmux set -g @claude_limits "$lim#[fg=#45475a]│ " 2>/dev/null || true; fi
printf '%s' "$model${pct:+ · ctx ${pct}%}${cost_fmt:+ · $cost_fmt}"
