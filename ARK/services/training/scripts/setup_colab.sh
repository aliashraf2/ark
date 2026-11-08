#!/usr/bin/env bash
# ARK Colab / Linux setup: clone, Node.js, npm deps, Python env.
#
# Idempotent stages; safe to re-run. Usage:
#   ARK_REPO_URL=<url> [ARK_REV=<branch|tag|sha>] [ARK_WORK_DIR=/content/ARK] \
#     bash setup_colab.sh [clone|node|npm|python|all]
#
# For private repos, embed a token in ARK_REPO_URL via a Colab secret
# (https://<token>@github.com/<org>/<repo>.git). This script never prints the URL.
set -euo pipefail

STAGE="${1:-all}"
WORK_DIR="${ARK_WORK_DIR:-/content/ARK}"
REV="${ARK_REV:-}"
NODE_MAJOR_REQUIRED=18
NODE_LTS_MAJOR=22

log() { printf '[setup] %s\n' "$*"; }
die() { printf '[setup] ERROR: %s\n' "$*" >&2; exit 1; }

stage_clone() {
  [ -n "${ARK_REPO_URL:-}" ] || die "ARK_REPO_URL is empty. Set the repository URL first."
  if [ -d "$WORK_DIR/.git" ]; then
    log "Reusing existing checkout at $WORK_DIR"
    git -C "$WORK_DIR" fetch --tags origin || die "git fetch failed."
  else
    log "Cloning repository into $WORK_DIR"
    mkdir -p "$(dirname "$WORK_DIR")"
    # Full clone (small repo): supports branch, tag, and pinned SHA checkout.
    git clone "$ARK_REPO_URL" "$WORK_DIR" || die "git clone failed. Check the URL and credentials."
  fi
  if [ -n "$REV" ]; then
    git -C "$WORK_DIR" checkout "$REV" || die "Cannot checkout revision '$REV'."
  fi
  log "Checked out: $(git -C "$WORK_DIR" rev-parse --short HEAD) $(git -C "$WORK_DIR" describe --tags --always --dirty 2>/dev/null || true)"
}

have_node_ge() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge "$1" ] 2>/dev/null
}

stage_node() {
  if have_node_ge "$NODE_MAJOR_REQUIRED"; then
    log "Node.js $(node --version) already satisfies >= $NODE_MAJOR_REQUIRED. Leaving it alone."
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required to install Node.js."
  log "Installing Node.js $NODE_LTS_MAJOR LTS via NodeSource (current runtime is older than $NODE_MAJOR_REQUIRED)."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_LTS_MAJOR}.x" -o /tmp/nodesource_setup.sh
  if [ "$(id -u)" -eq 0 ]; then
    bash /tmp/nodesource_setup.sh
    apt-get install -y nodejs
  elif command -v sudo >/dev/null 2>&1; then
    sudo -E bash /tmp/nodesource_setup.sh
    sudo apt-get install -y nodejs
  else
    die "Need root or sudo to install Node.js."
  fi
  have_node_ge "$NODE_MAJOR_REQUIRED" || die "Node.js install did not yield >= $NODE_MAJOR_REQUIRED."
  log "Node.js $(node --version), npm $(npm --version)"
}

stage_npm() {
  [ -d "$WORK_DIR" ] || die "Working directory $WORK_DIR missing. Run the clone stage first."
  [ -f "$WORK_DIR/package-lock.json" ] || die "package-lock.json missing; refusing unpinned install."
  log "Installing npm workspaces (npm ci) in $WORK_DIR"
  (cd "$WORK_DIR" && npm ci --no-audit --no-fund)
  [ -x "$WORK_DIR/node_modules/.bin/tsx" ] || die "tsx missing after npm ci."
  log "tsx OK. Rapier: $((cd "$WORK_DIR" && node -p "require('./node_modules/@dimforge/rapier3d-compat/package.json').version"))"
}

stage_python() {
  local pyproj="$WORK_DIR/services/training/python"
  [ -d "$pyproj" ] || die "ark_gym project missing. Run clone + npm stages first."
  if [ "${ARK_COLAB:-0}" = "1" ]; then
    stage_python_colab "$pyproj"
    return 0
  fi
  if ! command -v uv >/dev/null 2>&1; then
    log "Installing uv (official installer, ~/.local/bin)."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v uv >/dev/null 2>&1 || die "uv install failed."
  log "Syncing Python env from uv.lock (pinned deps)."
  uv sync --project "$WORK_DIR/services/training/python" --group dev
  uv run --project "$WORK_DIR/services/training/python" python -c "import ark_gym, gymnasium, numpy; print('ark_gym', ark_gym.__version__, '| gymnasium', gymnasium.__version__, '| numpy', numpy.__version__)"
}

# Colab path: install into the notebook kernel's own Python (uv venvs are
# invisible to Colab cells). Gymnasium is pinned from uv.lock (single source
# of truth); NumPy floats at >=1.26 so Colab's preinstalled build is kept when
# compatible. Actual versions are recorded in the diagnostic artifacts.
stage_python_colab() {
  local pyproj="$1"
  local gym_pin
  gym_pin="$(python3 - "$pyproj/uv.lock" <<'EOF'
import sys, tomllib
lock = tomllib.load(open(sys.argv[1], "rb"))
for pkg in lock["package"]:
    if pkg["name"] == "gymnasium":
        print(pkg["version"])
        break
EOF
)"
  [ -n "$gym_pin" ] || die "Could not read pinned gymnasium version from uv.lock."
  log "Installing into notebook Python (gymnasium==$gym_pin, numpy>=1.26, pytest, ark_gym)."
  python3 -m pip install -q "gymnasium==$gym_pin" "numpy>=1.26" "pytest>=8" || die "pip install of Python deps failed."
  python3 -m pip install -q -e "$pyproj" --no-deps || die "pip install of ark_gym failed."
  python3 -c "import ark_gym, gymnasium, numpy; print('ark_gym', ark_gym.__version__, '| gymnasium', gymnasium.__version__, '| numpy', numpy.__version__)"
}

case "$STAGE" in
  clone) stage_clone ;;
  node) stage_node ;;
  npm) stage_npm ;;
  python) stage_python ;;
  all) stage_clone; stage_node; stage_npm; stage_python ;;
  *) die "Unknown stage '$STAGE'. Use clone|node|npm|python|all." ;;
esac
log "Stage '$STAGE' complete."
