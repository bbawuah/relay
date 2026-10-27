#!/usr/bin/env bash
# Pusht het werk van een Codex-werker zonder netwerk. Dunne schil om push-werker.ts (de logica staat daar, met uitleg en de
# toetsen): LAB_AGENT_ROL=lead scripts/lead/push-werker.sh [--droog] <worktree-van-de-werker> <sha> <tak>
set -euo pipefail
exec "${LAB_LEAD_BUN:-bun}" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/push-werker.ts" "$@"
