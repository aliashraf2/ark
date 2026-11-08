#!/usr/bin/env bash
# One command from any directory: ./scripts/deploy-vultr.sh
set -euo pipefail
ARK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v python3 >/dev/null 2>&1 || { echo 'Install Python 3.10+ to run the deployment launcher.' >&2; exit 1; }
exec python3 "$ARK_ROOT/deploy/vultr/deploy.py" "$@"
