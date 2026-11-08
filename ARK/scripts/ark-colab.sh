#!/usr/bin/env bash
# ark-colab.sh — manage Google Colab runtimes for ARK training from the terminal.
#
# Thin, explicit wrapper around the official `colab` CLI (google-colab-cli).
# Every remote operation maps to a verified `colab` subcommand; see --help and
# docs/architecture/colab-cli.md. Verified against colab 0.7.5.
#
# Usage: ./scripts/ark-colab.sh [--json] <command> [options]
set -euo pipefail

# ARK_COLAB_ROOT overrides auto-detection (used by the test suite).
ROOT="${ARK_COLAB_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# --- configuration (environment overrides; optional env file) -----------------
# shellcheck disable=SC1090
if [ -n "${ARK_COLAB_ENV_FILE:-}" ]; then
  [ -f "$ARK_COLAB_ENV_FILE" ] || { echo "error: ARK_COLAB_ENV_FILE not found: $ARK_COLAB_ENV_FILE" >&2; exit 1; }
  set -a; . "$ARK_COLAB_ENV_FILE"; set +a
elif [ -f "$ROOT/.ark-colab.env" ]; then
  set -a; . "$ROOT/.ark-colab.env"; set +a
fi

ARK_COLAB_BIN="${ARK_COLAB_BIN:-colab}"
ARK_COLAB_SESSION="${ARK_COLAB_SESSION:-ark-trainer}"
ARK_RUNTIME="${ARK_RUNTIME:-cpu}"
ARK_COLAB_TPU="${ARK_COLAB_TPU:-}"
ARK_COLAB_HIGH_MEM="${ARK_COLAB_HIGH_MEM:-0}"
ARK_NOTEBOOK="${ARK_NOTEBOOK:-services/training/notebooks/ARK_Colab_Setup.ipynb}"
ARK_REMOTE_DIR="${ARK_REMOTE_DIR:-/content/ark}"
ARK_OUTPUT_DIR="${ARK_OUTPUT_DIR:-$ROOT/artifacts/colab}"
ARK_COLAB_TIMEOUT="${ARK_COLAB_TIMEOUT:-1800}"
ARK_COLAB_AUTH="${ARK_COLAB_AUTH:-}"
JSON_OUT=0

GPU_ALLOW="T4 L4 G4 H100 A100"
TPU_ALLOW="v5e1 v6e1"

# --- output helpers (logs always go to stderr; stdout stays clean) ------------
log() { printf 'ark-colab: %s\n' "$*" >&2; }
die() { printf 'ark-colab: error: %s\n' "$*" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH."; }

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | tr '\n' ' '
}

emit_json() {
  # emit_json <cmd> <ok:true|false> [key=value ...]
  local cmd="$1" ok="$2"; shift 2
  local out="{\"cmd\":\"$cmd\",\"ok\":$ok"
  local kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    out="$out,\"$k\":\"$(json_escape "$v")\""
  done
  printf '%s}\n' "$out"
}

# --- colab invocation (global flags must precede the subcommand) --------------
colab_bin() {
  command -v "$ARK_COLAB_BIN" >/dev/null 2>&1 || die "colab CLI not found ('$ARK_COLAB_BIN'). Install: uv tool install google-colab-cli"
  printf '%s' "$ARK_COLAB_BIN"
}

run_colab() {
  # All global options first, then the subcommand and its args.
  if [ -n "$ARK_COLAB_AUTH" ]; then
    case "$ARK_COLAB_AUTH" in
      oauth2|adc) ;;
      *) die "ARK_COLAB_AUTH must be 'oauth2' or 'adc', got '$ARK_COLAB_AUTH'." ;;
    esac
    "$(colab_bin)" --auth "$ARK_COLAB_AUTH" "$@"
  else
    "$(colab_bin)" "$@"
  fi
}

# --- state (local metadata only; never credentials) ---------------------------
state_file() { printf '%s/.ark-colab-state' "$ARK_OUTPUT_DIR"; }

state_get() {
  local key="$1" file line
  file="$(state_file)"
  [ -f "$file" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "$key="*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done < "$file"
  return 1
}

state_set() {
  local key="$1" value="$2" file tmp
  file="$(state_file)"
  mkdir -p "$ARK_OUTPUT_DIR"
  tmp="$file.tmp.$$"
  if [ -f "$file" ]; then
    grep -v "^$key=" "$file" > "$tmp" 2>/dev/null || true
  else
    : > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

unique_path() {
  # unique_path <path>: append -N before the extension until free.
  local path="$1" base ext candidate n
  if [ ! -e "$path" ]; then printf '%s' "$path"; return 0; fi
  case "$path" in
    *.*) base="${path%.*}"; ext=".${path##*.}" ;;
    *) base="$path"; ext="" ;;
  esac
  n=1
  while :; do
    candidate="$base-$n$ext"
    if [ ! -e "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
    n=$((n + 1))
  done
}

resolve_notebook() {
  local nb="$1"
  case "$nb" in
    /*) printf '%s' "$nb" ;;
    *) printf '%s' "$ROOT/$nb" ;;
  esac
}

validate_notebook() {
  local nb="$1"
  [ -f "$nb" ] || die "notebook not found: $nb"
  case "$nb" in
    *.ipynb) ;;
    *) die "not a .ipynb notebook: $nb" ;;
  esac
  need python3
  python3 - "$nb" <<'EOF' || die "invalid notebook JSON: $nb"
import json, sys
nb = json.load(open(sys.argv[1]))
assert isinstance(nb, dict) and "cells" in nb and "nbformat" in nb, "missing nbformat keys"
EOF
}

session_exists() {
  # `colab status -s NAME` prints "Session 'NAME' not found" but still exits
  # 0 in google-colab-cli 0.7.5. Match the named row from `sessions` instead.
  local sessions
  sessions="$(run_colab sessions 2>/dev/null)" || return 1
  printf '%s\n' "$sessions" | awk -v name="[$ARK_COLAB_SESSION]" \
    'index($0, name " ") == 1 { found = 1 } END { exit !found }'
}

require_session() {
  session_exists || die "no session '$ARK_COLAB_SESSION'. Run: $0 start"
}

is_tty() { [ -t 0 ] && [ -t 1 ]; }

# --- commands -----------------------------------------------------------------
cmd_auth() {
  need "$(colab_bin)"
  if run_colab sessions </dev/null >/dev/null 2>&1; then
    log "already authenticated."
    if [ "$JSON_OUT" = 1 ]; then emit_json auth true authenticated=true
    fi
    return 0
  fi
  if ! is_tty; then
    cat >&2 <<'EOF'
ark-colab: not authenticated, and no interactive terminal is available.
Complete ONE of these from a terminal, then re-run:

  1) Browser OAuth (simplest):
       colab sessions
     Open the printed URL, approve, and paste back the code.

  2) Headless-friendly ADC (needs gcloud):
       gcloud auth application-default login \
         --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
     Then: ARK_COLAB_AUTH=adc ./scripts/ark-colab.sh <command>
EOF
    if [ "$JSON_OUT" = 1 ]; then emit_json auth false authenticated=false
    fi
    return 2
  fi
  log "opening interactive authentication (browser approval required)..."
  run_colab sessions
}

cmd_start() {
  local gpu="" tpu="" high_mem="$ARK_COLAB_HIGH_MEM" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --gpu) gpu="${2:-}"; shift 2 ;;
      --tpu) tpu="${2:-}"; shift 2 ;;
      --high-mem) high_mem=1; shift ;;
      --force) force=1; shift ;;
      *) die "start: unknown option '$1'." ;;
    esac
  done
  if [ -z "$gpu" ] && [ -z "$tpu" ]; then
    case "$ARK_RUNTIME" in
      cpu|CPU) ;;
      *) gpu="$ARK_RUNTIME" ;;
    esac
  fi
  [ -z "$tpu" ] && tpu="$ARK_COLAB_TPU"
  if [ -n "$gpu" ]; then
    case " $GPU_ALLOW " in
      *" $gpu "*) ;;
      *) die "unsupported GPU '$gpu'. Supported: $GPU_ALLOW (anything else silently becomes A100 — refusing)." ;;
    esac
  fi
  if [ -n "$tpu" ]; then
    case " $TPU_ALLOW " in
      *" $tpu "*) ;;
      *) die "unsupported TPU '$tpu'. Supported: $TPU_ALLOW." ;;
    esac
  fi
  if [ "$force" = 0 ] && session_exists; then
    log "reusing existing session '$ARK_COLAB_SESSION' (use --force to recreate)."
    run_colab status -s "$ARK_COLAB_SESSION"
    if [ "$JSON_OUT" = 1 ]; then emit_json start true reused=true session="$ARK_COLAB_SESSION"
    fi
    return 0
  fi
  if [ "$force" = 1 ] && session_exists; then
    log "stopping previous session '$ARK_COLAB_SESSION' (--force)."
    run_colab stop -s "$ARK_COLAB_SESSION" || die "could not stop previous session."
  fi
  log "creating session '$ARK_COLAB_SESSION' (gpu=${gpu:-none} tpu=${tpu:-none} high-mem=$high_mem)..."
  new_args=(-s "$ARK_COLAB_SESSION")
  [ -n "$gpu" ] && new_args=("${new_args[@]}" --gpu "$gpu")
  [ -n "$tpu" ] && new_args=("${new_args[@]}" --tpu "$tpu")
  [ "$high_mem" = 1 ] && new_args=("${new_args[@]}" --high-mem)
  run_colab new "${new_args[@]}" || die "session creation failed (a 400 usually means no quota for '${gpu:-${tpu:-cpu}}' — try T4 or cpu)."
  run_colab status -s "$ARK_COLAB_SESSION" || die "session created but status check failed."
  state_set SESSION "$ARK_COLAB_SESSION"
  state_set RUNTIME "${gpu:-${tpu:-cpu}}"
  if [ "$JSON_OUT" = 1 ]; then emit_json start true reused=false session="$ARK_COLAB_SESSION"
  fi
}

cmd_status() {
  require_session
  run_colab status -s "$ARK_COLAB_SESSION"
  log "--- compute balance ---"
  run_colab usage || log "(usage unavailable)"
  if [ "$JSON_OUT" = 1 ]; then emit_json status true session="$ARK_COLAB_SESSION"
  fi
}

cmd_upload() {
  local notebook="$ARK_NOTEBOOK"
  while [ $# -gt 0 ]; do
    case "$1" in
      --notebook) notebook="${2:-}"; shift 2 ;;
      *) die "upload: unknown option '$1'." ;;
    esac
  done
  [ -n "$notebook" ] || die "upload: --notebook requires a path."
  case "$notebook" in
    /*) : ;;
    *) notebook="$ROOT/$notebook" ;;
  esac
  validate_notebook "$notebook"
  require_session
  local remote="$ARK_REMOTE_DIR/notebooks/$(basename "$notebook")"
  log "uploading $(basename "$notebook") -> session '$ARK_COLAB_SESSION':$remote"
  run_colab upload -s "$ARK_COLAB_SESSION" "$notebook" "$remote" \
    || die "upload failed."
  log "stored on the runtime's temporary disk (not Drive); it vanishes with the VM."
  if [ "$JSON_OUT" = 1 ]; then emit_json upload true local="$notebook" remote="$remote"
  fi
}

write_extract_script() {
  # $1: output path, $2: tarball remote path, $3: dest dir.
  # Remote python: safe-extract, skipping protected checkpoint/output prefixes.
  cat > "$1" <<EOF
import os, tarfile
SRC = "$2"
DEST = "$3"
PROTECTED = ("checkpoints/", "artifacts/", "colab_artifacts/")
def safe(members):
    for m in members:
        name = m.name
        if name.startswith("/") or ".." in name.split("/"):
            continue
        if name.startswith(PROTECTED):
            continue
        yield m
os.makedirs(DEST, exist_ok=True)
with tarfile.open(SRC, "r:gz") as tf:
    members = list(safe(tf.getmembers()))
    tf.extractall(DEST, members=members)
print("extracted %d files to %s" % (len(members), DEST))
EOF
}

cmd_sync() {
  local committed_only=0 dry_run=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --committed-only) committed_only=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      *) die "sync: unknown option '$1'." ;;
    esac
  done
  need git; need tar; need gzip; need python3
  require_session
  local rev dirty ts tmp tarball file_list prefix
  rev="$(git -C "$ROOT" rev-parse HEAD)" || die "not a git checkout: $ROOT"
  dirty="$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')"
  prefix="$(git -C "$ROOT" rev-parse --show-prefix)"
  ts="$(date +%Y%m%d-%H%M%S)"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ark-sync.XXXXXX")" || die "mktemp failed."
  tarball="$tmp/ark-sync.tar.gz"
  file_list="$tmp/files.lst"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  log "archiving rev $rev (${dirty} dirty entries)..."
  # One file list drives the tarball: tracked files always, plus untracked
  # files unless --committed-only. git applies .gitignore, so node_modules,
  # .venv, .env, and artifacts are excluded without a duplicated exclude list.
  # Paths are rewritten relative to ROOT so nested checkouts land correctly.
  # --full-name: repo-relative paths regardless of nesting, so the prefix
  # strip below works whether ROOT is the repo root or a subdirectory.
  if [ "$committed_only" = 1 ]; then
    git -C "$ROOT" ls-files -z --full-name --cached > "$file_list.raw"
  else
    git -C "$ROOT" ls-files -z --full-name --cached --others --exclude-standard > "$file_list.raw"
  fi
  ARK_SYNC_PREFIX="$prefix" ARK_SYNC_ROOT="$ROOT" python3 - "$file_list.raw" "$file_list" <<'EOF'
import os, sys
prefix = os.environ.get("ARK_SYNC_PREFIX", "")
root = os.environ["ARK_SYNC_ROOT"]
src, dst = sys.argv[1], sys.argv[2]
out = []
for chunk in open(src, "rb").read().split(b"\0"):
    if not chunk:
        continue
    p = chunk.decode()
    if prefix and not p.startswith(prefix):
        continue  # outside the ARK subtree
    rel = p[len(prefix):] if prefix else p
    if not os.path.lexists(os.path.join(root, rel)):
        continue  # deleted from disk but still tracked
    out.append(rel)
open(dst, "wb").write(b"\0".join(a.encode() for a in out) + (b"\0" if out else b""))
EOF
  [ -s "$file_list" ] || die "nothing to sync (empty file list)."
  # No --ignore-failed-read: bsdtar (macOS) lacks it; missing files are
  # filtered above instead. Both tars honor --null -T.
  tar --null -czf "$tarball" -C "$ROOT" -T "$file_list" \
    || die "tarball build failed."
  local file_count
  file_count="$(tar -tzf "$tarball" | wc -l | tr -d ' ')"
  log "tarball: $file_count files, $(wc -c < "$tarball" | tr -d ' ') bytes."
  printf 'rev=%s\ndirty=%s\nfiles=%s\n' "$rev" "$dirty" "$file_count" > "$tmp/manifest.txt"
  if [ "$dry_run" = 1 ]; then
    log "dry run: not uploading."
    if [ "$JSON_OUT" = 1 ]; then emit_json sync true dry_run=true rev="$rev" files="$file_count"
    fi
    trap - EXIT; rm -rf "$tmp"
    return 0
  fi
  local remote_tar="/content/ark-sync-$ts.tar.gz"
  run_colab upload -s "$ARK_COLAB_SESSION" "$tarball" "$remote_tar" || die "tarball upload failed."
  write_extract_script "$tmp/extract.py" "$remote_tar" "$ARK_REMOTE_DIR"
  run_colab exec -s "$ARK_COLAB_SESSION" -f "$tmp/extract.py" --timeout 300 \
    || die "remote extract failed."
  run_colab rm -s "$ARK_COLAB_SESSION" "$remote_tar" >/dev/null 2>&1 || true
  log "remote tree:"
  run_colab ls -s "$ARK_COLAB_SESSION" "$ARK_REMOTE_DIR" || die "remote verify listing failed."
  state_set SYNC_REV "$rev"
  trap - EXIT; rm -rf "$tmp"
  log "synced rev $rev ($file_count files). Checkpoints/artifacts prefixes on the remote were left untouched."
  if [ "$JSON_OUT" = 1 ]; then emit_json sync true rev="$rev" files="$file_count" remote="$ARK_REMOTE_DIR"
  fi
}

run_lock() { printf '%s/.run.lock' "$ARK_OUTPUT_DIR"; }

cmd_run() {
  local timeout="$ARK_COLAB_TIMEOUT" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) timeout="${2:-}"; shift 2 ;;
      --force) force=1; shift ;;
      *) die "run: unknown option '$1'." ;;
    esac
  done
  local notebook
  notebook="$(resolve_notebook "$ARK_NOTEBOOK")"
  validate_notebook "$notebook"
  require_session
  mkdir -p "$ARK_OUTPUT_DIR/runs"
  if [ -d "$(run_lock)" ] && [ "$force" = 0 ]; then
    die "another run is in progress ($(run_lock) exists). Use --force to override."
  fi
  mkdir -p "$(run_lock)" 2>/dev/null || die "cannot create run lock."
  # shellcheck disable=SC2064
  trap "rmdir '$(run_lock)' 2>/dev/null || true" EXIT
  local run_id base out_nb dest rc=0
  run_id="$(date +%Y%m%d-%H%M%S)"
  base="$(basename "$notebook" .ipynb)"
  log "executing $base on '$ARK_COLAB_SESSION' (timeout ${timeout}s, live output below)..."
  run_colab exec -s "$ARK_COLAB_SESSION" -f "$notebook" --timeout "$timeout" || rc=$?
  trap - EXIT; rmdir "$(run_lock)" 2>/dev/null || true
  if [ "$rc" -ne 0 ]; then
    state_set LAST_RUN "$run_id:FAILED"
    if [ "$JSON_OUT" = 1 ]; then emit_json run false run_id="$run_id"
    fi
    die "remote execution failed (exit $rc). See: $0 logs"
  fi
  # The CLI writes <basename>_output.ipynb next to the input file; relocate it
  # into the run directory so the repo tree stays clean.
  out_nb="$(dirname "$notebook")/${base}_output.ipynb"
  dest="$(unique_path "$ARK_OUTPUT_DIR/runs/$run_id-$base-output.ipynb")"
  if [ -f "$out_nb" ]; then
    mv "$out_nb" "$dest"
    log "executed notebook saved: $dest"
  else
    log "warning: expected output notebook missing: $out_nb"
    dest=""
  fi
  state_set LAST_RUN "$run_id:OK"
  if [ "$JSON_OUT" = 1 ]; then emit_json run true run_id="$run_id" output="$dest"
  fi
}

cmd_logs() {
  local lines="" type="" format="jsonl"
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) lines="${2:-}"; shift 2 ;;
      --type) type="${2:-}"; shift 2 ;;
      --format) format="${2:-}"; shift 2 ;;
      *) die "logs: unknown option '$1'." ;;
    esac
  done
  case "$format" in
    jsonl|md|txt) ;;
    *) die "logs: --format must be jsonl, md, or txt." ;;
  esac
  require_session
  local logdir="$ARK_OUTPUT_DIR/logs" ts dest
  mkdir -p "$logdir"
  ts="$(date +%Y%m%d-%H%M%S)"
  dest="$(unique_path "$logdir/$ARK_COLAB_SESSION-$ts.$format")"
  log_args=(-s "$ARK_COLAB_SESSION")
  [ -n "$lines" ] && log_args=("${log_args[@]}" -n "$lines")
  [ -n "$type" ] && log_args=("${log_args[@]}" -t "$type")
  log_args=("${log_args[@]}" -o "$dest")
  run_colab log "${log_args[@]}" || die "log retrieval failed."
  log "saved: $dest (history export; live output streams only during 'run'/'exec'.)"
  if [ "$JSON_OUT" = 1 ]; then emit_json logs true file="$dest"
  fi
}

cmd_shell() {
  local cmd="" use_ssh=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -c) cmd="${2:-}"; shift 2 ;;
      --ssh) use_ssh=1; shift ;;
      *) die "shell: unknown option '$1'." ;;
    esac
  done
  require_session
  if [ -n "$cmd" ]; then
    log "batch shell via piped console (output may contain terminal-control bytes)..."
    printf '%s\nexit\n' "$cmd" | run_colab console -s "$ARK_COLAB_SESSION"
    return $?
  fi
  is_tty || die "shell needs an interactive terminal. Use: $0 shell -c 'command'"
  if [ "$use_ssh" = 1 ]; then
    log "opening SSH shell (WebSocket transport, no public ports)..."
    run_colab ssh -s "$ARK_COLAB_SESSION"
  else
    log "opening raw TTY console (tmux on the VM)..."
    run_colab console -s "$ARK_COLAB_SESSION"
  fi
}

cmd_download() {
  local recursive=0 remote="" outdir="$ARK_OUTPUT_DIR/downloads"
  while [ $# -gt 0 ]; do
    case "$1" in
      --recursive|-r) recursive=1; shift ;;
      --out) outdir="${2:-}"; shift 2 ;;
      -*) die "download: unknown option '$1'." ;;
      *) remote="$1"; shift ;;
    esac
  done
  require_session
  mkdir -p "$outdir"
  if [ -z "$remote" ]; then
    remote="$ARK_REMOTE_DIR/colab_artifacts/ark_colab_diagnostics.json"
    log "no path given; downloading default diagnostics artifact."
  fi
  if [ "$recursive" = 0 ]; then
    local dest
    dest="$(unique_path "$outdir/$(basename "$remote")")"
    run_colab download -s "$ARK_COLAB_SESSION" "$remote" "$dest" || {
      log "remote listing of $ARK_REMOTE_DIR for reference:"
      run_colab ls -s "$ARK_COLAB_SESSION" "$ARK_REMOTE_DIR" || true
      die "download failed: $remote"
    }
    log "saved: $dest"
    if [ "$JSON_OUT" = 1 ]; then emit_json download true remote="$remote" local="$dest"
    fi
    return 0
  fi
  need python3
  local ts tmp pack_script remote_tar dest
  ts="$(date +%Y%m%d-%H%M%S)"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ark-dl.XXXXXX")" || die "mktemp failed."
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  remote_tar="/content/ark-dl-$ts.tar.gz"
  pack_script="$tmp/pack.py"
  cat > "$pack_script" <<EOF
import os, tarfile
SRC = "$remote"
with tarfile.open("$remote_tar", "w:gz") as tf:
    if os.path.isdir(SRC):
        tf.add(SRC, arcname=os.path.basename(SRC.rstrip("/")))
    else:
        tf.add(SRC, arcname=os.path.basename(SRC))
print("packed", SRC)
EOF
  run_colab exec -s "$ARK_COLAB_SESSION" -f "$pack_script" --timeout 300 || die "remote pack failed."
  dest="$(unique_path "$outdir/$(basename "$remote")-$ts.tar.gz")"
  run_colab download -s "$ARK_COLAB_SESSION" "$remote_tar" "$dest" || die "tarball download failed."
  run_colab rm -s "$ARK_COLAB_SESSION" "$remote_tar" >/dev/null 2>&1 || true
  tar -tzf "$dest" >/dev/null || die "downloaded tarball is corrupt: $dest"
  tar -tzf "$dest" | head -20 >&2
  trap - EXIT; rm -rf "$tmp"
  log "saved tarball: $dest (extract with: tar -xzf <file> -C <dir>)"
  if [ "$JSON_OUT" = 1 ]; then emit_json download true remote="$remote" local="$dest"
  fi
}

cmd_stop() {
  local yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes) yes=1; shift ;;
      *) die "stop: unknown option '$1'." ;;
    esac
  done
  if [ "$yes" = 0 ]; then
    if ! is_tty; then
      die "refusing to stop '$ARK_COLAB_SESSION' without confirmation (no TTY). Re-run with --yes."
    fi
    printf "Stop session '%s' and lose its temporary disk? [y/N] " "$ARK_COLAB_SESSION" >&2
    read -r answer || answer=""
    case "$answer" in
      y|Y|yes|YES) ;;
      *) log "aborted."; return 1 ;;
    esac
  fi
  run_colab stop -s "$ARK_COLAB_SESSION" || die "stop failed."
  state_set SESSION ""
  log "session stopped and released."
  if [ "$JSON_OUT" = 1 ]; then emit_json stop true session="$ARK_COLAB_SESSION"
  fi
}

cmd_all() {
  local force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1; shift ;;
      *) die "all: unknown option '$1'." ;;
    esac
  done
  need "$(colab_bin)"; need python3; need git; need tar; need gzip
  run_colab sessions </dev/null >/dev/null 2>&1 \
    || die "not authenticated. Run interactively first: $0 auth"
  log "=== 1/7 start (reuse if present) ==="
  cmd_start
  log "=== 2/7 sync code ==="
  cmd_sync
  log "=== 3/7 upload notebook ==="
  cmd_upload
  log "=== 4/7 verify remote ==="
  run_colab ls -s "$ARK_COLAB_SESSION" "$ARK_REMOTE_DIR" || die "remote verify failed."
  log "=== 5/7 run ==="
  if [ "$force" = 1 ]; then cmd_run --force; else cmd_run; fi
  log "=== 6/7 logs ==="
  cmd_logs
  log "=== 7/7 download ==="
  cmd_download || log "(default artifact download failed; use '$0 download <path>' explicitly.)"
  log "=== done; runtime '$ARK_COLAB_SESSION' left running (stop with: $0 stop) ==="
  if [ "$JSON_OUT" = 1 ]; then emit_json all true session="$ARK_COLAB_SESSION"
  fi
}

usage() {
  cat <<'EOF'
ark-colab.sh — ARK training on Google Colab from the terminal.

Usage: ark-colab.sh [--json] <command> [options]

Commands (each maps to verified `colab` CLI operations):
  auth                  Check auth; guide through browser/ADC login if needed
  start [--gpu X|--tpu X|--high-mem|--force]
                        Reuse session or provision one (X: T4 L4 G4 H100 A100)
  status                Session status + compute-unit balance
  upload [--notebook P] Validate and upload notebook to the runtime (temp disk)
  sync [--committed-only|--dry-run]
                        Ship repo (tracked + untracked, minus ignores) as tarball
  run [--timeout S|--force]
                        Execute notebook remotely; save executed copy locally
  logs [-n N] [--type T] [--format jsonl|md|txt]
                        Export session history (post-hoc; live output is in run)
  shell [-c CMD] [--ssh]
                        Interactive console/SSH shell, or one batch command
  download [REMOTE] [--out D] [--recursive]
                        Fetch files (default: diagnostics JSON)
  stop [--yes]          Stop session (asks unless --yes); disk is lost
  all [--force]         auth-check, start, sync, upload, verify, run, logs, download
  help                  This text

Global:
  --json                Machine-readable one-line result per command (logs on stderr)

Config (env vars or $ROOT/.ark-colab.env; see scripts/ark-colab.env.example):
  ARK_COLAB_BIN, ARK_COLAB_SESSION (ark-trainer), ARK_RUNTIME (cpu),
  ARK_COLAB_TPU, ARK_COLAB_HIGH_MEM, ARK_NOTEBOOK, ARK_REMOTE_DIR,
  ARK_OUTPUT_DIR, ARK_COLAB_TIMEOUT (1800), ARK_COLAB_AUTH (oauth2|adc)

Verified against: colab 0.7.5 (google-colab-cli).
EOF
}

main() {
  if [ $# -gt 0 ] && [ "$1" = "--json" ]; then JSON_OUT=1; shift; fi
  local cmd="${1:-help}"
  case "$cmd" in
    --help|-h|help) usage; return 0 ;;
  esac
  shift || true
  # ${1+"$@"}: bash 3.2 (macOS) aborts on empty "$@" under `set -u`.
  case "$cmd" in
    auth) cmd_auth ${1+"$@"} ;;
    start) cmd_start ${1+"$@"} ;;
    status) cmd_status ${1+"$@"} ;;
    upload) cmd_upload ${1+"$@"} ;;
    sync) cmd_sync ${1+"$@"} ;;
    run) cmd_run ${1+"$@"} ;;
    logs) cmd_logs ${1+"$@"} ;;
    shell) cmd_shell ${1+"$@"} ;;
    download) cmd_download ${1+"$@"} ;;
    stop) cmd_stop ${1+"$@"} ;;
    all) cmd_all ${1+"$@"} ;;
    *) die "unknown command '$cmd'. See: $0 help" ;;
  esac
}

main ${1+"$@"}
