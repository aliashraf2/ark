#!/usr/bin/env bash
# Tests for scripts/ark-colab.sh using a mock `colab` binary.
# No network, no Google account needed. Exit nonzero on any failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$HERE/../ark-colab.sh"
MOCK="$HERE/mocks/colab"
chmod +x "$MOCK"

PASS=0; FAIL=0
failures=""

pass() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1)); failures="$failures
  - $1: $2"
  printf 'FAIL %s: %s\n' "$1" "$2"
}

# w [VAR=val ...] -- <wrapper args...>: run wrapper in the test sandbox.
# Sandbox globals: W_D (dir), W_MOCK_SESS (sessions the mock knows).
w() {
  local envs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; break ;;
      *=*) envs+=("$1"); shift ;;
      *) break ;;
    esac
  done
  mkdir -p "$W_D/stage"
  # ${var-default} (no colon): empty stays empty, only unset gets default.
  if [ "${#envs[@]}" -gt 0 ]; then
    env "ARK_COLAB_BIN=$MOCK" "ARK_COLAB_SESSION=${W_SESS-ut-sess}" \
      "ARK_OUTPUT_DIR=$W_D/out" "MOCK_COLAB_LOG=$W_D/calls.log" \
      "MOCK_COLAB_STAGEDIR=$W_D/stage" "MOCK_COLAB_SESSIONS=${W_MOCK_SESS-ut-sess}" \
      "${envs[@]}" "$WRAPPER" "$@"
  else
    env "ARK_COLAB_BIN=$MOCK" "ARK_COLAB_SESSION=${W_SESS-ut-sess}" \
      "ARK_OUTPUT_DIR=$W_D/out" "MOCK_COLAB_LOG=$W_D/calls.log" \
      "MOCK_COLAB_STAGEDIR=$W_D/stage" "MOCK_COLAB_SESSIONS=${W_MOCK_SESS-ut-sess}" \
      "$WRAPPER" "$@"
  fi
}

expect_ok() {
  local name="$1"; shift
  if "$@" >/tmp/ark-test.out 2>&1; then pass "$name"; else fail "$name" "exit=$? $(head -c 300 /tmp/ark-test.out)"; fi
}
expect_fail() {
  local name="$1"; shift
  if "$@" >/tmp/ark-test.out 2>&1; then fail "$name" "expected failure, got exit 0"; else pass "$name"; fi
}
expect_log() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then pass "$1"; else fail "$1" "missing '$3' in $2"; fi
}
expect_no_log() {
  if grep -qF -- "$3" "$2" 2>/dev/null; then fail "$1" "unexpected '$3' in $2"; else pass "$1"; fi
}

new_sandbox() {
  W_D="$(mktemp -d "${TMPDIR:-/tmp}/ark-colab-test.XXXXXX")"
  mkdir -p "$W_D/out"
  W_MOCK_SESS="ut-sess"
  W_SESS="ut-sess"
}

# --- 1. syntax + help ---------------------------------------------------------
bash -n "$WRAPPER" && pass "wrapper syntax" || fail "wrapper syntax" "bash -n failed"
bash -n "$MOCK" && pass "mock syntax" || fail "mock syntax" "bash -n failed"
expect_ok "help exits 0" "$WRAPPER" help
"$WRAPPER" help 2>/dev/null | grep -q "ark-colab.sh" && pass "help text" || fail "help text" "missing banner"
expect_fail "unknown command fails" "$WRAPPER" bogus-cmd

# --- 2. missing dependencies --------------------------------------------------
new_sandbox
ARK_COLAB_BIN=/nonexistent/colab expect_fail "missing colab binary" \
  env "ARK_COLAB_BIN=/nonexistent/colab" "ARK_OUTPUT_DIR=$W_D/out" "$WRAPPER" status
rm -rf "$W_D"

# --- 3. notebook validation ---------------------------------------------------
new_sandbox
expect_fail "missing notebook" w "ARK_NOTEBOOK=$W_D/nope.ipynb" -- upload
printf 'not json{{{' > "$W_D/bad.ipynb"
expect_fail "invalid notebook" w "ARK_NOTEBOOK=$W_D/bad.ipynb" -- upload
printf 'text' > "$W_D/file.txt"
expect_fail "non-ipynb rejected" w "ARK_NOTEBOOK=$W_D/file.txt" -- upload
rm -rf "$W_D"

# --- 4. upload with spaces in path + env overrides ----------------------------
new_sandbox
mkdir -p "$W_D/my dir"
printf '{"nbformat":4,"cells":[]}' > "$W_D/my dir/nb with spaces.ipynb"
expect_ok "upload spaces path" w "ARK_NOTEBOOK=$W_D/my dir/nb with spaces.ipynb" -- upload
expect_log "upload called remote" "$W_D/calls.log" "upload -s ut-sess"
expect_log "upload kept spaces" "$W_D/calls.log" "nb with spaces.ipynb"
rm -rf "$W_D"

new_sandbox
printf '{"nbformat":4,"cells":[]}' > "$W_D/n.ipynb"
W_SESS="custom-name"; W_MOCK_SESS="custom-name"
expect_ok "session override" w "ARK_NOTEBOOK=$W_D/n.ipynb" -- upload
expect_log "override reaches CLI" "$W_D/calls.log" "-s custom-name"
rm -rf "$W_D"

# --- 5. start: create vs reuse, GPU validation --------------------------------
new_sandbox; W_MOCK_SESS=""
: > "$W_D/sessions"
expect_ok "start creates" w "MOCK_COLAB_SESSIONS_FILE=$W_D/sessions" -- start
expect_log "start calls new" "$W_D/calls.log" "new -s ut-sess"
grep -q "^SESSION=ut-sess$" "$W_D/out/.ark-colab-state" 2>/dev/null \
  && pass "start records state" || fail "start records state" "missing state"
rm -rf "$W_D"

new_sandbox
expect_ok "start reuses" w -- start
expect_no_log "reuse skips new" "$W_D/calls.log" " new "
rm -rf "$W_D"

new_sandbox; W_MOCK_SESS=""
expect_fail "bad GPU rejected" w -- start --gpu BOGUS
expect_no_log "bad GPU no-op" "$W_D/calls.log" " new "
expect_fail "failed creation" w "MOCK_COLAB_FAIL_NEW=1" -- start
rm -rf "$W_D"

# --- 6. sync (fixture git repo; staged tarball content asserted) ---------------
mk_fixture_repo() {
  local r="$1"
  mkdir -p "$r"
  git -C "$r" init -q 2>/dev/null
  git -C "$r" config user.email t@t.t; git -C "$r" config user.name t
  printf 'print(1)\n' > "$r/keep.py"
  mkdir -p "$r/node_modules" "$r/.venv" "$r/pkg"
  printf 'x' > "$r/node_modules/skip.js"
  printf 'x' > "$r/.venv/skip.py"
  printf 'secret' > "$r/.env"
  printf 'tracked\n' > "$r/pkg/a.py"
  printf 'node_modules/\n.venv/\n.env\n' > "$r/.gitignore"
  git -C "$r" add keep.py pkg .gitignore && git -C "$r" commit -qm init
  printf 'untracked\n' > "$r/pkg/new file.py"
}
new_sandbox
mk_fixture_repo "$W_D/repo"
expect_ok "sync ok" w "ARK_COLAB_ROOT=$W_D/repo" "ARK_REMOTE_DIR=/content/ark" -- sync
staged="$(ls "$W_D/stage"/*.tar.gz 2>/dev/null | head -1)"
if [ -n "$staged" ]; then
  listing="$(tar -tzf "$staged")"
  echo "$listing" | grep -qx "keep.py" && pass "sync has tracked" || fail "sync has tracked" "$listing"
  echo "$listing" | grep -qx "pkg/new file.py" && pass "sync has untracked spaces" || fail "sync has untracked spaces" "$listing"
  if echo "$listing" | grep -q "node_modules\|\.venv\|\.env\|\.git/"; then fail "sync excludes" "$listing"; else pass "sync excludes"; fi
else
  fail "sync staged tarball" "mock did not stage upload"
fi
expect_log "sync extracts remotely" "$W_D/calls.log" "exec -s ut-sess -f"
rm -rf "$W_D"

new_sandbox
mk_fixture_repo "$W_D/repo"
expect_fail "sync extract failure" w "ARK_COLAB_ROOT=$W_D/repo" "MOCK_COLAB_FAIL_EXEC=1" -- sync
rm -rf "$W_D"

# --- 7. run: success, failure, lock -------------------------------------------
new_sandbox
printf '{"nbformat":4,"cells":[]}' > "$W_D/r.ipynb"
expect_ok "run ok" w "ARK_NOTEBOOK=$W_D/r.ipynb" -- run
ls "$W_D/out/runs/"*-r-output.ipynb >/dev/null 2>&1 \
  && pass "run relocates output" || fail "run relocates output" "missing moved notebook"
[ ! -d "$W_D/out/.run.lock" ] && pass "run releases lock" || fail "run releases lock" "lock left behind"
rm -rf "$W_D"

new_sandbox
printf '{"nbformat":4,"cells":[]}' > "$W_D/r.ipynb"
expect_fail "run failure propagates" w "ARK_NOTEBOOK=$W_D/r.ipynb" "MOCK_COLAB_FAIL_EXEC=1" -- run
rm -rf "$W_D"

new_sandbox
printf '{"nbformat":4,"cells":[]}' > "$W_D/r.ipynb"
mkdir -p "$W_D/out/.run.lock"
expect_fail "run lock blocks" w "ARK_NOTEBOOK=$W_D/r.ipynb" -- run
rm -rf "$W_D"

# --- 8. logs + download -------------------------------------------------------
new_sandbox
expect_ok "logs ok" w -- logs
ls "$W_D/out/logs/"ut-sess-*.jsonl >/dev/null 2>&1 \
  && pass "logs saved namespaced" || fail "logs saved namespaced" "missing file"
rm -rf "$W_D"

new_sandbox
mkdir -p "$W_D/out/downloads"
printf 'existing' > "$W_D/out/downloads/d.json"
expect_ok "download ok" w -- download /content/ark/d.json
[ -f "$W_D/out/downloads/d-1.json" ] \
  && pass "download collision-safe" || fail "download collision-safe" "$(ls "$W_D/out/downloads")"
[ "$(cat "$W_D/out/downloads/d.json")" = "existing" ] \
  && pass "download preserves existing" || fail "download preserves existing" "overwritten"
rm -rf "$W_D"

new_sandbox
expect_fail "download failure" w "MOCK_COLAB_FAIL_DOWNLOAD=1" -- download /content/ark/d.json
rm -rf "$W_D"

new_sandbox
expect_ok "download recursive" w -- download --recursive /content/ark/colab_artifacts
ls "$W_D/out/downloads/"*.tar.gz >/dev/null 2>&1 \
  && pass "recursive tarball saved" || fail "recursive tarball saved" "missing"
rm -rf "$W_D"

# --- 8b. sync from a nested checkout (ROOT is a repo subdirectory) -------------
new_sandbox
mk_fixture_repo "$W_D/repo"
mkdir -p "$W_D/repo/sub"
printf 'nested\n' > "$W_D/repo/sub/inner.py"
git -C "$W_D/repo" add sub && git -C "$W_D/repo" commit -qm nested
expect_ok "sync nested root" w "ARK_COLAB_ROOT=$W_D/repo/sub" "ARK_REMOTE_DIR=/content/ark" -- sync
staged="$(ls "$W_D/stage"/*.tar.gz 2>/dev/null | head -1)"
if [ -n "$staged" ]; then
  listing="$(tar -tzf "$staged")"
  echo "$listing" | grep -qx "inner.py" && pass "nested paths relative" || fail "nested paths relative" "$listing"
  if echo "$listing" | grep -q "keep.py\|^sub/"; then fail "nested excludes outside" "$listing"; else pass "nested excludes outside"; fi
else
  fail "nested staged tarball" "mock did not stage upload"
fi
rm -rf "$W_D"

# --- 9. stop confirmation -----------------------------------------------------
new_sandbox
if w -- stop </dev/null >/tmp/ark-test.out 2>&1; then fail "stop needs confirm" "exit 0"; else pass "stop needs confirm"; fi
expect_ok "stop --yes" w -- stop --yes
expect_log "stop calls CLI" "$W_D/calls.log" "stop -s ut-sess"
rm -rf "$W_D"

# --- 10. auth + json mode -----------------------------------------------------
new_sandbox
if w -- auth </dev/null >/tmp/ark-test.out 2>&1; then pass "auth already-authed"; else fail "auth already-authed" "failed"; fi
if w "MOCK_COLAB_AUTH=0" -- auth </dev/null >/tmp/ark-test.out 2>&1; then fail "auth guides when unauth" "exit 0"; else pass "auth guides when unauth"; fi
grep -q "gcloud auth application-default" /tmp/ark-test.out \
  && pass "auth prints ADC guide" || fail "auth prints ADC guide" "missing"
rm -rf "$W_D"

new_sandbox
expect_ok "json status ok" w -- --json status
grep -q '"cmd":"status","ok":true' /tmp/ark-test.out \
  && pass "json envelope" || fail "json envelope" "$(head -c 200 /tmp/ark-test.out)"
rm -rf "$W_D"

# --- 11. shell batch + all (mocked end-to-end) --------------------------------
new_sandbox
expect_ok "shell -c" w -- shell -c 'echo hi'
expect_log "shell pipes console" "$W_D/calls.log" "console -s ut-sess"
rm -rf "$W_D"

new_sandbox
mk_fixture_repo "$W_D/repo"
printf '{"nbformat":4,"cells":[]}' > "$W_D/repo/nb.ipynb"
: > "$W_D/sessions"
W_MOCK_SESS=""
expect_ok "all end-to-end" w "ARK_COLAB_ROOT=$W_D/repo" "ARK_NOTEBOOK=$W_D/repo/nb.ipynb" \
  "MOCK_COLAB_SESSIONS_FILE=$W_D/sessions" -- all
for want in "new -s" "upload -s" "exec -s" "log -s" "download -s"; do
  expect_log "all covers $want" "$W_D/calls.log" "$want"
done
rm -rf "$W_D"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf 'failures:%s\n' "$failures"; exit 1; fi
