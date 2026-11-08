# ARK on Google Colab from the terminal

`scripts/ark-colab.sh` manages Colab runtimes for ARK training without a
browser tab. It is a thin wrapper around the official
[`google-colab-cli`](https://github.com/googlecolab/google-colab-cli)
(`colab` on `PATH`); every remote operation maps to a verified subcommand.
Verified against **colab 0.7.5** on macOS (Linux works the same; Windows is
not supported by the upstream CLI).

## Install

```bash
# Official CLI (one of):
uv tool install google-colab-cli
pip install google-colab-cli

# Verify what you got (this doc's claims come from these):
colab version
colab --help
colab <subcommand> --help
colab readme        # bundled manual
colab skill         # bundled agent guide
```

No other dependencies: the wrapper needs `bash`, `git`, `tar`, `gzip`,
`python3` (all present on macOS).

## Authenticate (one-time, interactive)

```bash
./scripts/ark-colab.sh auth
```

- Already logged in → reports success (exit 0).
- Otherwise, from a terminal it runs `colab sessions`, which prints a Google
  OAuth URL; approve in the browser and paste back the code. Tokens are
  cached by the CLI at `~/.config/colab-cli/`, never in this repo.
- Without a TTY it prints setup guidance and exits 2 instead of hanging.

Headless-friendly alternative (needs `gcloud`):

```bash
gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
export ARK_COLAB_AUTH=adc
```

Note: `colab auth` is *VM-side* GCP credentials for notebook code — it does
not log the CLI in. A CLI 401/403 is always a scope/identity problem; see
`colab whoami` (hidden debug command).

Default-auth discrepancy: installed `--help` says the `--auth` default is
`oauth2`, while the bundled skill/README claim `adc`. The wrapper passes no
`--auth` flag unless `ARK_COLAB_AUTH` is set, i.e. it follows the binary's
behavior; set the variable explicitly to be deterministic.

## Configure

Environment variables, or copy the template (git-ignored, never holds tokens):

```bash
cp scripts/ark-colab.env.example .ark-colab.env
```

| Variable | Default | Meaning |
|---|---|---|
| `ARK_COLAB_SESSION` | `ark-trainer` | Session name, always explicit |
| `ARK_RUNTIME` | `cpu` | `cpu` or `T4 L4 G4 H100 A100` |
| `ARK_COLAB_TPU` | _(empty)_ | `v5e1` / `v6e1` |
| `ARK_COLAB_HIGH_MEM` | `0` | `1` for high-RAM shape (Pro/Pro+) |
| `ARK_NOTEBOOK` | `services/training/notebooks/ARK_Colab_Setup.ipynb` | Notebook to run |
| `ARK_REMOTE_DIR` | `/content/ark` | Remote project root (temp disk) |
| `ARK_OUTPUT_DIR` | `<repo>/artifacts/colab` | Local runs/logs/downloads |
| `ARK_COLAB_TIMEOUT` | `1800` | Remote exec timeout, seconds |
| `ARK_COLAB_AUTH` | _(empty)_ | `oauth2` or `adc` |
| `ARK_COLAB_BIN` | `colab` | CLI binary (tests point at a mock) |

## Sessions: start, reuse, status, stop

```bash
./scripts/ark-colab.sh start                 # reuse ark-trainer if alive, else CPU
./scripts/ark-colab.sh start --gpu T4        # request a T4 (fails loudly without quota)
ARK_RUNTIME=A100 ./scripts/ark-colab.sh start --force   # recreate as A100
./scripts/ark-colab.sh status                # hardware, state + compute balance
./scripts/ark-colab.sh stop                  # asks first (use --yes in scripts)
```

- A session is one Jupyter kernel on one rented VM. `status` confirms the
  real accelerator — the wrapper never claims a GPU the provider didn't grant.
- Unknown `--gpu` values are rejected locally: upstream silently falls back
  to A100, which then fails confusingly.
- A `400` on `new` means no quota/entitlement → fall back to `--gpu T4` or CPU.
- Session metadata (name, runtime, last run) lives in
  `artifacts/colab/.ark-colab-state`. Backend truth stays in the CLI's own
  `~/.config/colab-cli/sessions.json`.

## Sync code and upload the notebook

```bash
./scripts/ark-colab.sh sync                   # tracked + untracked (minus ignores)
./scripts/ark-colab.sh sync --committed-only  # HEAD only, for pure reproducibility
./scripts/ark-colab.sh sync --dry-run         # report what would ship
./scripts/ark-colab.sh upload                 # validate + upload configured notebook
./scripts/ark-colab.sh upload --notebook path/to/custom.ipynb
```

- `sync` builds one tarball from `git ls-files` (tracked, plus untracked
  unless `--committed-only`), so `.gitignore` excludes `node_modules`,
  `.venv`, `.env`, and artifacts with no duplicated exclude list. Paths are
  rewritten relative to the ARK root, so nested checkouts land correctly.
- The tarball is uploaded and extracted by remote Python (`exec`), skipping
  `checkpoints/`, `artifacts/`, and `colab_artifacts/` prefixes so a sync
  never clobbers remote training outputs. The tarball is removed afterwards.
- `upload` rejects missing files, non-`.ipynb` names, and invalid notebook
  JSON before touching the network.
- Both land on the runtime's **temporary disk** (`/content/ark/...`), not in
  Drive. Everything there dies with the VM — download results before `stop`.

## Run, logs, shell

```bash
./scripts/ark-colab.sh run                    # exec notebook, live output, 1800s cap
./scripts/ark-colab.sh logs                   # export history -> artifacts/colab/logs/
./scripts/ark-colab.sh logs -n 50 --format md # last 50 events as Markdown
./scripts/ark-colab.sh shell                  # interactive tmux console on the VM
./scripts/ark-colab.sh shell --ssh            # ...or SSH over WebSocket (no open ports)
./scripts/ark-colab.sh shell -c 'nvidia-smi'  # one batch command (scriptable)
```

- `run` refuses concurrent runs via a lock dir (override: `--force`), streams
  kernel output live, fails loudly on remote errors, and moves the CLI's
  `<name>_output.ipynb` into `artifacts/colab/runs/<ts>-<name>-output.ipynb`.
- `logs` exports *history* (`jsonl`/`md`/`txt`); there is no separate live
  tail — the live stream is `run`'s own stdout/stderr.
- `shell` needs a TTY except for `-c`. Piped-console output can contain
  terminal-control bytes; filter with `grep -a`. `drivemount`/`auth`
  (VM-side) genuinely need a human and are intentionally not wrapped.

## Download results

```bash
./scripts/ark-colab.sh download                                  # default diagnostics JSON
./scripts/ark-colab.sh download /content/ark/checkpoints/model.pt
./scripts/ark-colab.sh download --recursive /content/ark/colab_artifacts
```

- Single files download directly; `--recursive` packs remotely (remote
  Python `tarfile`, since `download` is file-only), fetches one tarball, and
  lists its contents. Remote pack files are cleaned up.
- Local names are collision-safe (`model-1.pt`, never overwrite).

## Full workflow

```bash
./scripts/ark-colab.sh all
```

Checks deps + auth (non-interactive: fails with guidance instead of
prompting), then start → sync → upload → remote verify → run → logs →
download, leaving the runtime up. Every step aborts the chain on failure.

## Machine use (Muse)

```bash
./scripts/ark-colab.sh --json status   # one JSON object on stdout; logs on stderr
```

- `--json` prints a single result object per command; human logs always go
  to stderr, so stdout stays parseable. Failures: nonzero exit + stderr text.
- Exit codes: `0` ok, `1` failure, `2` needs interactive auth/confirmation.
- The wrapper runs from any cwd, quotes all paths, and takes no `sudo`.

## Runtime limits (Colab-side, not wrapper bugs)

- Temporary disk: `/content` is wiped when the VM stops or is reclaimed.
- Sessions go IDLE/BUSY; the backend may prune VMs — re-run `start` (it
  reuses when possible, recreates otherwise) and `sync` again.
- GPUs/TPUs are quota- and tier-gated; most accounts only get CPU.
- Idle VMs burn compute units: `stop` when done. `colab usage` shows balance.

## Tests

```bash
./scripts/tests/test-ark-colab.sh   # 60 checks, mocked CLI, no account needed
```

The mock (`scripts/tests/mocks/colab`) emulates sessions, files, exec
(including `_output.ipynb` generation), logs, and failures. Remote behavior
against real Google infrastructure is *not* covered by mocks — see below.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `not authenticated` / exit 2 | Run `auth` from a terminal once |
| 401/403 from any command | Scopes/identity; run `colab whoami`, re-do ADC with all four scopes |
| `400` on start with GPU | No quota → `--gpu T4` or CPU |
| `session not found` / 404 | Backend pruned the VM; `start` again, then `sync` |
| Wedged kernel, VM alive | `colab restart-kernel -s NAME` (or stop/start) |
| `tsx`/bridge missing remotely | Re-run `sync`; check the tarball file count in its output |
| `another run is in progress` | Stale `.run.lock` → inspect, then `run --force` |

## Known limitations

1. **No live remote testing in this environment.** The wrapper was verified
   against `colab 0.7.5 --help`/`readme`/`skill` plus 55 mocked tests; the
   account holding this machine is not authenticated, so no real session was
   ever created here. First authenticated `all` run is the remaining proof.
2. **No recursive primitives upstream.** Directory sync/download are
   tarball-over-`exec` compositions, not native recursive transfers.
3. **No live log tail.** History export only; live output exists solely
   during `run`/`exec`.
4. **`colab auth` / `drivemount` need a human TTY** and are deliberately
   unwrapped (documented above instead).
5. **Notebook outputs land beside the input file** (upstream behavior); the
   wrapper relocates them into `artifacts/colab/runs/`.
6. Upstream `--auth` default is documented inconsistently (`oauth2` in
   `--help`, `adc` in skill/README); the wrapper defaults to the binary's
   behavior — set `ARK_COLAB_AUTH` to pin it.
