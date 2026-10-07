#!/usr/bin/env bash
# Demo van de lead-hooks in een wegwerpomgeving (voor de PR-body). Raakt nooit de echte
# ~/.claude, ~/.local/state of een tmux-server: tijdelijke HOME, CLAUDE_CONFIG_DIR en staatmap,
# nep-hook-JSON door hook.sh, de installer alleen met --droog op een tijdelijke settings.json.
# Gebruik: bash scripts/lead/hooks/demo.sh
set -euo pipefail

HIER=$(cd "$(dirname "$0")" && pwd)
LEAD_DIR=$(dirname "$HIER")
T=$(mktemp -d "${TMPDIR:-/tmp}/lead-hooks-demo.XXXXXX")
trap 'rm -rf "$T"' EXIT

export HOME="$T/home" CLAUDE_CONFIG_DIR="$T/home/.claude" LAB_LEAD_STAAT="$T/staat"
mkdir -p "$CLAUDE_CONFIG_DIR" "$T/werk"
BUN=$(command -v bun)
export LAB_LEAD_BUN="$BUN"
unset TMUX TMUX_PANE LAB_AGENT_ROL LAB_AGENT_NAAM LAB_LEAD_NAAM LAB_OPDRACHT

# hook <rol> <naam> <lead> <session_id> <json-restant>: stuurt een event door hook.sh
hook() {
  local rol=$1 naam=$2 lead=$3 sid=$4 rest=$5
  printf '{"session_id":"%s","cwd":"%s",%s}' "$sid" "$T/werk" "$rest" |
    LAB_AGENT_ROL="$rol" LAB_AGENT_NAAM="$naam" LAB_LEAD_NAAM="$lead" LAB_OPDRACHT="$T/werk/$naam/OPDRACHT.md" TMUX_PANE="%7" \
      sh "$HIER/hook.sh"
}
ev() { printf '"hook_event_name":"%s"' "$1"; }

echo "== setup: lead 'lead', agents w1 en w2, sub-lead sl met een subagent"
hook lead lead lead sid-lead "$(ev SessionStart)"
hook agent w1 lead sid-w1 "$(ev SessionStart)"
hook agent w2 lead sid-w2 "$(ev SessionStart)"
hook sublead sl lead sid-sl "$(ev SessionStart)"
hook agent w1 lead sid-w1 "$(ev UserPromptSubmit)"
hook agent w1 lead sid-w1 "$(ev PreToolUse),\"tool_name\":\"Edit\""
hook agent w2 lead sid-w2 "$(ev PreToolUse),\"tool_name\":\"Bash\""
hook agent w2 lead sid-w2 "$(ev Notification),\"notification_type\":\"permission_prompt\""
hook sublead sl lead sid-sl "$(ev PreToolUse),\"tool_name\":\"Agent\""
hook sublead sl lead sid-sl "$(ev SubagentStart),\"agent_id\":\"a3f9c2\",\"agent_type\":\"general-purpose\""
hook sublead sl lead sid-sl "$(ev PreToolUse),\"tool_name\":\"Edit\",\"agent_id\":\"a3f9c2\",\"agent_type\":\"general-purpose\""

echo
echo "== (i) scripts/lead/status.sh --lead lead"
sh "$LEAD_DIR/status.sh" --lead lead

echo
echo "== (ii) Stop van w1 zonder rapport (er was een tool in de beurt, geen SendMessage naar de lead)"
out=$(hook agent w1 lead sid-w1 "$(ev Stop)") && rc=0 || rc=$?
echo "Stop-uitvoer: $out (exit $rc)"

echo
echo "== (iii) w1 meldt zich met SendMessage aan de lead (met 'vrij'), daarna dezelfde Stop"
hook agent w1 lead sid-w1 "$(ev PostToolUse),\"tool_name\":\"SendMessage\",\"tool_input\":{\"to\":\"lead\",\"message\":\"PR 99, sha abc1234, poort groen. Ik ben vrij.\"}"
out=$(hook agent w1 lead sid-w1 "$(ev Stop)") && rc=0 || rc=$?
echo "Stop-uitvoer: ${out:-(leeg: doorgelaten)} (exit $rc)"
echo "inbox/lead.jsonl:"
sed 's/^/  /' "$LAB_LEAD_STAAT/inbox/lead.jsonl"
echo "Volgende prompt van de lead (additionalContext):"
hook lead lead lead sid-lead "$(ev UserPromptSubmit)"
echo
sh "$LEAD_DIR/status.sh" --lead lead

echo
echo "== (iv) installeer-hooks.ts --droog op een tijdelijke settings.json"
printf '%s\n' '{
  "model": "opus",
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.claude/tmux/status.sh Stop" }] }],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "~/.claude/tmux/status.sh PreToolUse" }] },
      { "matcher": "Bash|Read|Grep|Glob|NotebookRead", "hooks": [{ "type": "command", "command": "~/.claude/hooks/grenzen.sh", "timeout": 10 }] }
    ]
  }
}' >"$T/settings.json"
voor=$(cksum <"$T/settings.json")
"$BUN" "$LEAD_DIR/installeer-hooks.ts" --droog --settings "$T/settings.json" --doel "$T/doel/lab-lead-hooks" --met-wekker
if [ "$voor" = "$(cksum <"$T/settings.json")" ] && [ ! -e "$T/doel" ]; then echo "(gecontroleerd: settings.json ongewijzigd, niets gekopieerd)"; fi
