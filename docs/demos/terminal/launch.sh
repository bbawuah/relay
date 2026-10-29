#!/bin/sh
# Starts ONE native CLI process for a role (non-interactive), shows its Relay activity, and reports its exit.
# Args: role session requested-by. Hard deadline 240 s per process (supervise.py: own session/group, TERM then KILL).
role=$1; session=$2; by=$3; D=$RELAY_DEMO_DIR
W="$D/bin/relay-$role"; kind=${role%%-*}; out="$D/proof/out-$role-$session.txt"
now() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
ev() { printf '{"t":%s,"kind":"process","what":"%s","role":"%s","session":"%s","by":"%s"%s}\n' "$(now)" "$1" "$role" "$session" "$by" "$2" >> "$D/proof/events.jsonl"; }
RULES="You are '$role', one of four demo agents using Relay, a local mailbox tool. Use ONLY these commands, one per Bash call, with no shell operators: $W (verbs send, inbox, ack), sleep (at most 8 seconds)"
case "$role-$session" in
claude-parent-main)
 TASK="$RULES, and $D/bin/start-claude-child (no arguments). Do not use any other tool or file.
1) Run: $W send codex-parent 'Design question: for a fixed-size log tail, ring buffer or linked list? Reply with a recommendation after your own helper checks one aspect.' --request-key plan-1
Then run the identical command once more (a retry; expect duplicate true).
2) Run: $W send claude-sub 'One sentence: why does a ring buffer suit a fixed-size log tail?' --request-key sub-1
Then run $D/bin/start-claude-child once; it asks the shell to start your helper process in the lower-left pane.
3) Poll $W inbox (sleep 5 between polls, at most 20 polls) until a message from claude-sub arrives, then run $W ack ID with its id.
4) Finish with one line saying what you did. Do not wait for codex-parent." ;;
claude-sub-main)
 TASK="$RULES. Do not use any other tool or file.
1) Poll $W inbox (sleep 3 between polls, at most 25 polls) until a message from claude-parent arrives.
2) Run $W ack ID with its id.
3) Run $W send claude-parent '<your one-sentence answer>' --request-key sub-1-reply --conversation <its conversationId> --reply-to <its id>
4) Finish with one line." ;;
codex-parent-main)
 TASK="$RULES, and $D/bin/start-codex-child (no arguments). Do not use any other tool or file.
1) Poll $W inbox (sleep 3 between polls, at most 20 polls) until a message from claude-parent arrives. Then run $W inbox a second time (reading must not remove it).
2) Run $W ack ID with its id.
3) Run: $W send codex-sub 'One sentence: one drawback of a linked list for a fixed-size log tail.' --request-key sub-2
Then run $D/bin/start-codex-child once; it asks the shell to start your helper process in the lower-right pane.
4) Poll $W inbox (sleep 3 between polls, at most 25 polls) until a message from codex-sub arrives, then run $W ack ID with its id.
5) Run $W send claude-parent 'Review: ring buffer recommended. Helper note: <short summary of the helper sentence>' --request-key final-1 --conversation <conversationId of the message from claude-parent> --reply-to <that message id>
6) Finish with one line." ;;
codex-sub-main)
 TASK="$RULES. Do not use any other tool or file.
1) Poll $W inbox (sleep 3 between polls, at most 25 polls) until a message from codex-parent arrives.
2) Run $W ack ID with its id.
3) Run $W send codex-parent '<your one-sentence answer>' --request-key sub-2-reply --conversation <its conversationId> --reply-to <its id>
4) Finish with one line." ;;
claude-parent-review)
 TASK="$RULES. Do not use any other tool or file.
1) Poll $W inbox (sleep 3 between polls, at most 15 polls) until a message from codex-parent arrives.
2) Run $W ack ID with its id.
3) Run $W send codex-parent 'Review received: ring buffer it is.' --request-key final-ack-1 --conversation <its conversationId> --reply-to <its id>
4) Finish with one line." ;;
esac
HELPER="$D/bin/start-claude-child"
here=$(cd "$(dirname "$0")" && pwd)
if [ "$kind" = claude ]; then
  label="claude -p · --model sonnet · --effort low · allowed tools: own wrapper only"
  allow="Bash($W *)"; set -- --allowedTools "$allow" "Bash(sleep *)"
  [ "$session" = main ] && [ "$role" = claude-parent ] && set -- "$@" "Bash($HELPER)"
  set -- claude -p --model sonnet --effort low --no-session-persistence --output-format json "$@" -- "$TASK"
else
  label="codex exec · -m gpt-6.1-sol · native default effort · sandbox workspace-write"
  set -- codex exec -m gpt-6.1-sol -s workspace-write --add-dir "$D/state" --add-dir "$D/proof" --add-dir "$D/home" \
      --skip-git-repo-check --ephemeral --color never -C "$D/cwd" -- "$TASK"
fi
: > "$out"
pf="$D/proof/sup-$role-$session.pid"
python3 -I "$here/supervise.py" "$out" "$pf" 240 "$D/cwd" -- "$@" &
sup=$!
tail -n 0 -f "$D/proof/pane-$role.log" &
tp=$!
trap 'kill -TERM $sup 2>/dev/null; kill $tp 2>/dev/null' HUP INT TERM
printf '\033[1;35m[process]\033[0m %s started by %s\n\033[2m(shell/tmux process creation, not Relay)\n%s\033[0m\n' "$role" "$by" "$label"
ev start ""
touch "$D/proof/started-$role-$session"
start=$(date +%s)
wait $sup; rc=$?
while [ $rc -ge 129 ] && kill -0 $sup 2>/dev/null; do wait $sup; rc=$?; done  # a trapped signal interrupts wait; keep waiting for the supervisor
sleep 0.6; kill $tp 2>/dev/null
model="not reported"; effort=""
if [ "$kind" = claude ]; then
  m=$(python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(','.join((d.get('modelUsage') or {}).keys()))" "$out" 2>/dev/null); [ -n "$m" ] && model=$m
else
  m=$(grep -m1 -i '^model:' "$out" | sed 's/^[Mm]odel: *//'); [ -n "$m" ] && model=$m
  e=$(grep -m1 -i '^reasoning effort:' "$out" | sed 's/^[Rr]easoning effort: *//'); [ -n "$e" ] && effort=" · effort (CLI header): $e"
fi
printf '\033[1;35m[process]\033[0m %s exited rc %s after %ss\n\033[2mmodel (CLI metadata): %s%s\033[0m\n' "$role" "$rc" "$(( $(date +%s) - start ))" "$model" "$effort"
ev exit ",\"rc\":$rc,\"model\":\"$model\",\"effort\":\"${effort# · effort (CLI header): }\""
echo "$rc" > "$D/proof/exit-$role-$session.tmp" && mv "$D/proof/exit-$role-$session.tmp" "$D/proof/exit-$role-$session"
