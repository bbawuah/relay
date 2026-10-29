#!/bin/sh
# Rebuilds docs/media/*.gif and *-poster.png from the sanitised casts.
# Needs macOS (swiftc, CoreText) and ffmpeg. Nothing is installed; the renderer
# is compiled into a temporary directory. To re-record the casts first, run
# `bun docs/demos/capture.ts handoff` and `... subagents` (uses disposable state).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
media="$here/../media"
tmp=$(mktemp -d /private/tmp/relay-demo-render.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
swiftc -O "$here/render.swift" -o "$tmp/render"
# Live captures (agents ran the relay commands) and the scripted CLI replays.
live="REPLAY of captured live agent output | Codex gpt-6.1-sol + Claude sonnet-5-5 via T3"
scripted="REPLAY of a real Relay CLI run | scripted roles | no AI model"
mkdir -p "$media"
build() { # cast captions label gif-name
  "$tmp/render" "$here/casts/$1.jsonl" "$here/captions/$2.json" "$tmp/$3" "$4" >/dev/null
  (cd "$tmp/$3" && ffmpeg -v error -y -f concat -i list.ffconcat \
    -vf "fps=8,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none" -loop 0 "$3.gif")
  cp "$tmp/$3/$3.gif" "$media/$3.gif"
  cp "$tmp/$3/poster.png" "$media/$3-poster.png"
}
build live-handoff live-handoff relay-live-handoff "$live"
build live-subagents live-subagents relay-live-subagents "$live"
build handoff handoff relay-scripted-handoff "$scripted"
build subagents subagents relay-scripted-subagents "$scripted"
ls -l "$media"
