#!/usr/bin/env bash
#
# build-all.sh — One-shot build + global registration for `minimum`.
#
# Builds the whole stack in dependency order and exposes the `minimum`
# command globally:
#
#   1. Engine (root)  : npm install + tsc + copy-assets  ->  dist/index.js
#   2. TUI (tui/)     : npm install + tsc                 ->  tui/dist/cli.js
#   3. Register CLI   : npm link                          ->  global `minimum`
#
# The TUI dynamically imports the engine from ../../dist/index.js at runtime,
# so the engine MUST be built before the TUI is useful. bin/minimum-ink.js
# spawns tui/dist/cli.js, which is why both builds are required for the
# command palette (incl. /orchestrate) to show up.
#
# Usage:
#   scripts/build-all.sh            # full build + global link
#   scripts/build-all.sh --no-link  # build only, skip global registration
#   scripts/build-all.sh --clean    # remove dist/ + tui/dist/ first

set -euo pipefail

# ── Resolve repo root regardless of where the script is invoked from ─────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Flags ────────────────────────────────────────────────────────────────────
DO_LINK=1
DO_CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --no-link) DO_LINK=0 ;;
    --clean)   DO_CLEAN=1 ;;
    -h|--help)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ── Pretty logging ────────────────────────────────────────────────────────────
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# NEW: detect the known vitest / coverage-v8 major-version mismatch so we can
# skip the noisy failing install attempt and go straight to --legacy-peer-deps.
has_known_peer_conflict() {
  local prefix="$1"
  local package_json="$prefix/package.json"

  [ -f "$package_json" ] || return 1

  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const vitest = deps.vitest;
    const coverage = deps["@vitest/coverage-v8"];
    const major = (value) => {
      const match = String(value || "").match(/\d+/);
      return match ? match[0] : "";
    };
    process.exit(vitest && coverage && major(vitest) !== major(coverage) ? 0 : 1);
  ' "$package_json"
}

# npm install that tolerates the repo's known peer-dep conflict
# (@vitest/coverage-v8 wants a newer vitest than the pinned one). Uses
# --legacy-peer-deps immediately for the known mismatch; otherwise retries with
# it before doing a lightweight cleanup.
npm_install_attempt() {
  local prefix="$1"
  shift || true
  npm --prefix "$prefix" install "$@"
}

npm_install() {
  local prefix="$1"
  local prefer_legacy=0

  if has_known_peer_conflict "$prefix"; then
    warn "Detected known peer-dep conflict in $prefix — using --legacy-peer-deps"
    prefer_legacy=1
  fi

  if [ "$prefer_legacy" -eq 1 ]; then
    if npm_install_attempt "$prefix" --legacy-peer-deps; then
      return 0
    fi
  else
    if npm_install_attempt "$prefix"; then
      return 0
    fi

    warn "Install failed — retrying with --legacy-peer-deps"
    if npm_install_attempt "$prefix" --legacy-peer-deps; then
      return 0
    fi
  fi

  warn "Install still failed — clearing node_modules and retrying once"
  rm -rf "$prefix/node_modules"

  if [ "$prefer_legacy" -eq 1 ]; then
    npm_install_attempt "$prefix" --legacy-peer-deps
    return $?
  fi

  if npm_install_attempt "$prefix"; then
    return 0
  fi

  npm_install_attempt "$prefix" --legacy-peer-deps
}

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is not installed"
command -v npm  >/dev/null 2>&1 || die "npm is not installed"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node >= 22 required (found $(node -v))"
ok "Toolchain: node $(node -v), npm $(npm -v)"

# ── Optional clean ────────────────────────────────────────────────────────────
if [ "$DO_CLEAN" -eq 1 ]; then
  step "Cleaning previous build artifacts"
  rm -rf "$ROOT_DIR/dist" "$ROOT_DIR/tui/dist"
  ok "Removed dist/ and tui/dist/"
fi

# ── 1. Engine (root) ──────────────────────────────────────────────────────────
step "Installing engine dependencies (root)"
npm_install "$ROOT_DIR"
ok "Engine dependencies installed"

step "Building engine -> dist/index.js"
npm run build
[ -f "$ROOT_DIR/dist/index.js" ] || die "Engine build produced no dist/index.js"
ok "Engine built"

# ── 2. TUI (tui/) ─────────────────────────────────────────────────────────────
step "Installing TUI dependencies (tui/)"
npm_install "$ROOT_DIR/tui"
ok "TUI dependencies installed"

step "Building TUI -> tui/dist/cli.js"
npm --prefix "$ROOT_DIR/tui" run build
[ -f "$ROOT_DIR/tui/dist/cli.js" ] || die "TUI build produced no tui/dist/cli.js"
ok "TUI built"

# ── 3. Register the global `minimum` command ─────────────────────────────────
if [ "$DO_LINK" -eq 1 ]; then
  step "Registering global \`minimum\` command (npm link)"
  npm link
  if command -v minimum >/dev/null 2>&1; then
    ok "\`minimum\` registered -> $(command -v minimum)"
  else
    printf '\033[1;33m! npm link succeeded but \`minimum\` is not on PATH.\033[0m\n'
    printf '  Add npm global bin to PATH: \033[36m%s\033[0m\n' "$(npm prefix -g)/bin"
  fi
else
  step "Skipping global registration (--no-link)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1;32m━━ Build complete ━━\033[0m\n'
printf '  engine : %s\n' "$ROOT_DIR/dist/index.js"
printf '  tui    : %s\n' "$ROOT_DIR/tui/dist/cli.js"
if [ "$DO_LINK" -eq 1 ]; then
  printf '  command: run \033[36mminimum\033[0m to launch the TUI\n'
else
  printf '  run    : \033[36mnode bin/minimum-ink.js\033[0m\n'
fi
printf '  tip    : set \033[36mMIMO_API_KEY\033[0m for the live engine (else mock runner)\n'
