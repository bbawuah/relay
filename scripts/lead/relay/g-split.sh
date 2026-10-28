#!/usr/bin/env bash
# CONCEPT: Brian draait dit pas buiten een sandbox, na onafhankelijke review.
# Bouwt uitsluitend een nieuwe lokale $HOME/relay vanuit origin/main. Nooit pushen.
set -euo pipefail

readonly MARKER=.relay-split-marker
readonly HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly BRON="${RELAY_BRON_REPO:-$(cd "$HIER/../../.." && pwd -P)}"
readonly DOEL="${RELAY_DOEL:-$HOME/relay}"
readonly GIT_BIN="${RELAY_GIT:-git}"

fout() { printf 'FOUT g-split: %s\n' "$*" >&2; exit 2; }
ok() { printf 'OK g-split: %s\n' "$*"; }
gebruik() { printf 'gebruik: %s [--droog]\n' "$0" >&2; exit 64; }

DROOG=nee
case "${1:-}" in
  "") ;;
  --droog) DROOG=ja ;;
  *) gebruik ;;
esac

[ -d "$BRON/.git" ] || "$GIT_BIN" -C "$BRON" rev-parse --git-dir >/dev/null 2>&1 || fout "bron is geen git-repository: $BRON"
"$GIT_BIN" -C "$BRON" remote get-url origin >/dev/null 2>&1 || fout "bron heeft geen origin; origin/main is vereist"

if [ -e "$DOEL" ] && [ ! -f "$DOEL/$MARKER" ]; then
  fout "$DOEL bestaat zonder $MARKER; niets overschreven"
fi

if [ "$DROOG" = ja ]; then
  printf 'DROOG g-split: filter origin/main uit %s naar %s; geen bestanden geschreven\n' "$BRON" "$DOEL"
  if [ -e "$DOEL" ]; then printf 'DROOG g-split: bestaande gemarkeerde doelmap wordt eerst geback-upt\n'; fi
  exit 0
fi

[ "${CONCEPT_UITVOEREN:-}" = JA ] || fout 'zet CONCEPT_UITVOEREN=JA om te schrijven'
command -v "$GIT_BIN" >/dev/null 2>&1 || fout "git ontbreekt: $GIT_BIN"
"$GIT_BIN" filter-repo --help >/dev/null 2>&1 || fout 'git filter-repo ontbreekt; installeer het eerst (geen fallback die historie verliest)'

tmpbasis="${TMPDIR:-/tmp}"
tmp="$(mktemp -d "$tmpbasis/relay-split.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
clone="$tmp/bron"

if [ -e "$DOEL" ]; then
  tijd="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${DOEL}.voor-split-${tijd}"
  [ ! -e "$backup" ] || fout "backup bestaat al: $backup"
  mv "$DOEL" "$backup"
  ok "bestaande gemarkeerde relay geback-upt naar $backup"
fi

"$GIT_BIN" clone --no-local "$BRON" "$clone" >/dev/null
"$GIT_BIN" -C "$clone" checkout --detach origin/main >/dev/null
# Meerdere paden behouden hun geschiedenis; scripts/lead bevat de hooks, peers en beleid.
"$GIT_BIN" -C "$clone" filter-repo --force \
  --path scripts/lead/ \
  --path agents/skills/ \
  --path scripts/poort.ts \
  --path scripts/poort.test.ts \
  --path scripts/lab.test.ts \
  --path scripts/scripts-tests-veilig.ts \
  --path scripts/scripts-tests-paden.test.ts \
  --path AGENTS.md
# Een lokale inspectierepo mag nooit per ongeluk naar LAB kunnen pushen.
"$GIT_BIN" -C "$clone" remote remove origin

mv "$clone" "$DOEL"
trap - EXIT
rm -rf "$tmp"

mkdir -p "$DOEL/.github/workflows" "$DOEL/tests"
printf 'gemaakt-door=g-split.sh\nbron=origin/main\n' > "$DOEL/$MARKER"
cat > "$DOEL/package.json" <<'EOF'
{"name":"relay","private":true,"scripts":{"poort":"bun test tests && bash tests/hook-canaries.sh","test":"bun run poort"}}
EOF
cat > "$DOEL/tests/hook-canaries.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test -f scripts/lead/hooks/grenzen.sh
test -f scripts/lead/hooks/hook.sh
EOF
chmod 755 "$DOEL/tests/hook-canaries.sh"
cat > "$DOEL/.github/workflows/ci.yml" <<'EOF'
name: poort
on: [push, pull_request]
jobs:
  poort:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun run poort
EOF
cat > "$DOEL/README.md" <<'EOF'
# relay

Lead-, worker-, peerbus- en beleidsautomatisering, los van een productrepository.
EOF
cat > "$DOEL/AGENTS.md" <<'EOF'
# relay

Deze repository bevat generieke orchestratielogica. Projectspecifieke checks, PR-regels en skills staan in `relay.toml` van het project.
EOF
cat > "$DOEL/relay.toml" <<'EOF'
# Ontwerp: dit bestand hoort uiteindelijk in het project dat relay gebruikt.
version = 1
[project]
default_branch = "main"
[checks]
full_gate = ["bun", "run", "poort"]
EOF
ok "lokale relay gebouwd in $DOEL (geen remote toegevoegd, niets gepusht)"
