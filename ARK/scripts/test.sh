#!/usr/bin/env bash
# ARK verification gates in one command.
#
# Usage: ./scripts/test.sh [all|backend|web|headless]
#   all      backend pytest + web tests + typecheck + production build + headless (default)
#   backend  Python agent tests only (fast)
#   web      simulator tests + typecheck + build
#   headless headless sim determinism gate only (fast)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-all}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' not found." >&2
    exit 1
  }
}

failures=0
section() {
  echo ""
  echo "===== $1 ====="
}

case "$TARGET" in
  backend | all)
    need uv
    section "backend: pytest (services/agent)"
    if [ ! -d "$ROOT/services/agent/.venv" ]; then
      (cd "$ROOT/services/agent" && uv sync --group dev)
    fi
    (cd "$ROOT/services/agent" && uv run pytest -q) || failures=$((failures + 1))
    ;;
esac

case "$TARGET" in
  web | all)
    need npm
    need node
    if [ ! -d "$ROOT/apps/simulator/node_modules" ]; then
      (cd "$ROOT/apps/simulator" && npm install)
    fi
    section "web: vitest (apps/simulator)"
    (cd "$ROOT/apps/simulator" && npm run test) || failures=$((failures + 1))
    section "web: typecheck (svelte-check + tsc)"
    (cd "$ROOT/apps/simulator" && npm run check) || failures=$((failures + 1))
    section "web: production build"
    (cd "$ROOT/apps/simulator" && npm run build) || failures=$((failures + 1))
    ;;
esac

case "$TARGET" in
  headless | all)
    need npm
    need node
    if [ ! -d "$ROOT/node_modules" ]; then
      (cd "$ROOT" && npm install)
    fi
    section "headless: determinism gate (sim:headless)"
    (cd "$ROOT" && npm run sim:headless -- --planet mars --seed 42 --steps 300 --check-determinism) || failures=$((failures + 1))
    ;;
esac

case "$TARGET" in
  all | backend | web | headless) ;;
  *)
    echo "error: unknown target '$TARGET' (expected all|backend|web|headless)." >&2
    exit 2
    ;;
esac

echo ""
if [ "$failures" -eq 0 ]; then
  echo "ALL GREEN ($TARGET)"
else
  echo "$failures section(s) FAILED ($TARGET)" >&2
  exit 1
fi
