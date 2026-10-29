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
label="REPLAY of a real Relay CLI run | scripted roles | no AI model"
mkdir -p "$media"
for s in handoff subagents; do
  "$tmp/render" "$here/casts/$s.jsonl" "$here/captions/$s.json" "$tmp/$s" "$label" >/dev/null
  (cd "$tmp/$s" && ffmpeg -v error -y -f concat -i list.ffconcat \
    -vf "fps=8,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none" -loop 0 "$s.gif")
  cp "$tmp/$s/$s.gif" "$media/relay-$s.gif"
  cp "$tmp/$s/poster.png" "$media/relay-$s-poster.png"
done
ls -l "$media"
