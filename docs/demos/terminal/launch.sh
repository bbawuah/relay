#!/bin/sh
# Starts ONE native CLI process for a role (non-interactive), shows its Relay activity, and reports its exit.
# Args: role session requested-by. Deadline 240 s per process.
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
if [ "$kind" = claude ]; then
  label="claude -p · --model sonnet · --effort low"
  extra=""; [ "$session" = main ] && [ "$role" = claude-parent ] && extra="Bash($D/bin/start-claude-child *)"
  ( cd "$D/cwd" && exec claude -p --model sonnet --effort low --no-session-persistence --output-format json \
      --allowedTools "Bash($W *)" "Bash(sleep *)" ${extra:+"$extra"} -- "$TASK" ) > "$out" 2>&1 &
else
  label="codex exec · -m gpt-6.1-sol · effort low · sandbox workspace-write"
  ( cd "$D/cwd" && exec codex exec -m gpt-6.1-sol -c model_reasoning_effort=low -s workspace-write \
      --add-dir "$D/state" --add-dir "$D/proof" --add-dir "$D/home" --skip-git-repo-check --ephemeral --color never \
      -C "$D/cwd" -- "$TASK" ) > "$out" 2>&1 &
fi
pid=$!
printf '\033[1;35m[process]\033[0m started by %s (shell, not Relay)\n\033[2m          %s\033[0m\n' "$by" "$label"
ev start ""
start=$(date +%s)
( sleep 240; kill $pid 2>/dev/null && echo "[deadline 240 s reached]" >> "$out" ) &
dog=$!
tail -n 0 -f "$D/proof/pane-$role.log" &
tp=$!
wait $pid; rc=$?
sleep 0.6; kill $tp $dog 2>/dev/null
model="not reported"
if [ "$kind" = claude ]; then
  m=$(python3 -I -c "import json,sys;d=json.load(open('$out'));print(','.join((d.get('modelUsage') or {}).keys()))" 2>/dev/null); [ -n "$m" ] && model=$m
else
  m=$(grep -m1 -i '^model:' "$out" | sed 's/^[Mm]odel: *//'); [ -n "$m" ] && model=$m
fi
printf '\033[1;35m[process]\033[0m exited %s after %ss\n\033[2m          model (CLI metadata): %s\033[0m\n' "$rc" "$(( $(date +%s) - start ))" "$model"
ev exit ",\"rc\":$rc,\"model\":\"$model\""
touch "$D/proof/exit-$role-$session"
