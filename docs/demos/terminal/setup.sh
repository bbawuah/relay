#!/bin/sh
# Creates a private demo dir: isolated Relay prefix/state/HOME, four registered peers (manual CLI bindings),
# per-agent wrappers and the two child-start helpers. Prints the dir. Touches nothing outside it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
D=$(mktemp -d /private/tmp/relay-h6run.XXXXXX)
mkdir -p "$D/home" "$D/cwd" "$D/bin" "$D/proof"
HOME="$D/home" "$repo/install.sh" --prefix "$D/prefix" >/dev/null 2>&1
R="$D/prefix/bin/relay"; BUN=$(command -v bun)
: > "$D/proof/peers.txt"
for a in claude-parent claude-sub codex-parent codex-sub; do
  id=$(HOME="$D/home" "$R" --state "$D/state" --namespace terminal-demo register --name "$a" 2>/dev/null)
  printf '%s %s\n' "$a" "$id" >> "$D/proof/peers.txt"
  printf '#!/bin/sh\nRELAY_DEMO_DIR=%s exec %s %s/as.ts %s "$@"\n' "$D" "$BUN" "$here" "$a" > "$D/bin/relay-$a"
done
python3 -I - "$D" <<'PY'
import json,sys
d=sys.argv[1]
json.dump({l.split()[0]:l.split()[1] for l in open(d+"/proof/peers.txt")},open(d+"/proof/peers.json","w"))
PY
# Narrow helpers: take no arguments, can only ask the shell to start the fixed child pane of their own parent.
mkhelper() { # kind parent
  cat > "$D/bin/start-$1-child" <<HELPER
#!/bin/sh
printf 'main $2\n' > "$D/proof/start-$1-sub.tmp" && mv "$D/proof/start-$1-sub.tmp" "$D/proof/start-$1-sub"
perl -MTime::HiRes=time -e 'printf qq({"t":%d,"kind":"process","what":"child-request","by":"$2","role":"$1-sub"}\n), time*1000' >> "$D/proof/events.jsonl"
HELPER
}
mkhelper claude claude-parent
mkhelper codex codex-parent
chmod +x "$D"/bin/*
echo "$D"
