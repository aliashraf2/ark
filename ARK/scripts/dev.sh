#!/usr/bin/env bash
# ARK one-command dev stack: agent backend (Python/FastAPI) + simulator (Vite/Svelte).
#
# Usage: ./scripts/dev.sh
#   AGENT_PORT=8000 SIM_PORT=5173 ./scripts/dev.sh   # custom ports
#
# Ctrl-C stops everything. First run installs dependencies automatically
# (uv sync for Python, npm install for the simulator).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_PORT="${AGENT_PORT:-8000}"
SIM_PORT="${SIM_PORT:-5173}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' not found. Install it first (https://docs.astral.sh/uv/ for uv, https://nodejs.org for node)." >&2
    exit 1
  }
}
need uv
need npm
need node

echo "==> ARK dev stack (backend :$AGENT_PORT, simulator :$SIM_PORT)"

# Install on first run so a fresh clone just works.
if [ ! -d "$ROOT/services/agent/.venv" ]; then
  echo "==> creating Python env (services/agent/.venv)"
  (cd "$ROOT/services/agent" && uv sync)
fi
if [ ! -d "$ROOT/apps/simulator/node_modules" ]; then
  echo "==> installing simulator dependencies"
  (cd "$ROOT/apps/simulator" && npm install)
fi

cleanup() {
  echo ""
  echo "==> stopping ARK dev stack"
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

(cd "$ROOT/services/agent" && uv run uvicorn app:app --port "$AGENT_PORT" 2>&1 | sed 's/^/[agent] /') &
(cd "$ROOT/apps/simulator" && npm run dev -- --port "$SIM_PORT" 2>&1 | sed 's/^/[sim] /') &

# Wait for both servers, then hand off URLs.
if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "http://localhost:$AGENT_PORT/api/health" 2>/dev/null && break
    sleep 1
  done
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "http://localhost:$SIM_PORT/" 2>/dev/null && break
    sleep 1
  done
fi

echo ""
echo "==> ARK is up:"
echo "    simulator: http://localhost:$SIM_PORT/   <-- open this in your browser"
echo "    agent API: http://localhost:$AGENT_PORT/api/health"
echo "    (If :$SIM_PORT was busy, Vite picked another port — see the [sim] lines above.)"
echo "    Press Ctrl-C to stop everything."
echo ""

wait
