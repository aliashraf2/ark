#!/usr/bin/env bash
# Runs as root on the VM with this release's runtime.env already prepared.
set -euo pipefail
RELEASE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_ROOT="${ARK_INSTALL_ROOT:-/opt/ark}"
CURRENT="$INSTALL_ROOT/current"
SHARED_ENV="$INSTALL_ROOT/shared/runtime.env"
PREVIOUS="$(readlink "$CURRENT" || true)"
compose() { docker compose --env-file "$RELEASE_ROOT/runtime.env" -p ark -f "$RELEASE_ROOT/deploy/vultr/compose.yaml" "$@"; }

# Keep the running release intact if building the new images fails.
compose build
if ! compose up -d --wait --wait-timeout 180; then
  if [[ "$PREVIOUS" == "$INSTALL_ROOT"/releases/* && -f "$SHARED_ENV" ]]; then
    echo 'New release failed its health check; restoring the previous containers.' >&2
    docker compose --env-file "$SHARED_ENV" -p ark -f "$PREVIOUS/deploy/vultr/compose.yaml" up -d --wait --wait-timeout 180 --no-build
  fi
  exit 1
fi
install -m 0600 "$RELEASE_ROOT/runtime.env" "$SHARED_ENV"
ln -sfn "$RELEASE_ROOT" "$CURRENT"
echo 'ARK containers are healthy; waiting for public HTTPS is handled by the launcher.'
