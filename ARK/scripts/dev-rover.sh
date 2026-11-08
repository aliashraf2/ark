#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AGENT_PORT=8001 SIM_PORT=5175 VITE_AGENT_URL=http://localhost:8001
export ARK_AGENT_DATA="$ROOT/.dev-rover/data" ARK_ENV_PATH="$ROOT/.dev-rover/agent.env"
unset ARK_PUBLIC_ORIGIN ARK_PROXY_TOKEN
exec "$ROOT/scripts/dev.sh"
