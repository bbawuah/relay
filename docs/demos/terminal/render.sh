#!/bin/bash
# Renders a 4-pane cast into PNG frames, a GIF and a poster. Needs macOS (swiftc, CoreText) and ffmpeg; builds in a temp dir.
# Usage: render.sh CAST.jsonl OUTBASE   (writes OUTBASE.gif, OUTBASE-poster.png, OUTBASE-full.png)
set -eu
here=$(cd "$(dirname "$0")" && pwd); cast=$1; base=$2
T=$(mktemp -d /private/tmp/relay-h6-render.XXXXXX)
swiftc -O "$here/../render-panes.swift" -o "$T/render-panes" 2>/dev/null
"$T/render-panes" "$cast" "$T/f"
ffmpeg -v error -y -f concat -safe 0 -i "$T/f/list.ffconcat" -vf "fps=8,split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=none" -loop 0 "$base.gif"
cp "$T/f/poster.png" "$base-poster.png"; cp "$T/f/poster.png" "$base-full.png"
rm -rf "$T"
ls -l "$base.gif" "$base-poster.png"
