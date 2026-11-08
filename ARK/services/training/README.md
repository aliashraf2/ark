# ARK Training Infrastructure

Python ↔ TypeScript RL bridge (Phase 6.3) over the headless Rapier core
(6.1) and the `reset()`/`step()` environment API (6.2).

```text
ArkEnv (Python, Gymnasium API)
        |  JSON Lines over stdin/stdout, one persistent process
        v
services/training/bridge/server.ts (Node, via repo-local tsx)
        |
        v
packages/rl ArkEnvironment  →  packages/physics Rapier core
```

No HTTP, no browser, no cloud endpoint — everything on one machine.

## Layout

- `bridge/` — persistent Node JSONL server: `server.ts` (transport),
  `protocol.ts` (request/response validation), `environmentRegistry.ts`
  (multi-env registry), `serialization.ts` (finite-number guard).
- `python/` — installable `ark_gym` package (`src/ark_gym/`), `tests/`,
  `examples/smoke_test.py`, `pyproject.toml`.
- `benchmark/rlBenchmark.ts`, `examples/randomAgent.ts`, `headless/main.ts` —
  the TS-side benchmark, smoke, and headless CLI from earlier phases.

## Setup (repo root)

```bash
npm install                                   # node deps incl. repo-local tsx
cd services/training/python
uv venv && uv pip install -e . && uv pip install pytest
```

Requires Python ≥ 3.11 and `uv` (or plain `python -m venv` + `pip`).
First Colab run needs only `npm install` + the venv — the bridge launches
through the repo-local `node_modules/.bin/tsx`, never a global install.

## Commands (repo root)

```bash
npm run bridge:test    # pytest suite (25 tests, real physics)
npm run bridge:smoke   # random-agent episode on Mars
npm test               # TS suites (physics + rl + simulator + bridge)
```

## Protocol (v1.0)

One JSON object + `\n` per request on stdin; one per response on stdout.
`stdout` carries ONLY responses — all diagnostics go to `stderr`.

Commands: `hello`, `create`, `reset`, `step`, `get_spaces`, `get_metrics`,
`close`, `shutdown`. Requests carry `{ protocolVersion, requestId, command,
envId?, payload? }`; responses echo `requestId` with `{ ok: true, result }`
or `{ ok: false, error: { code, message } }`. Error codes: `bad_request`,
`unknown_command`, `version_mismatch`, `unknown_env`, `env_limit`,
`validation_error`, `step_before_reset`, `step_after_done`, `env_error`,
`internal`. Malformed lines and unknown commands return errors without
killing the server; non-finite numbers are rejected, never serialized.

## Spaces and conventions (from the 6.2 contract, queried live)

- Observation: `Box((12,), float32)` — goal distance/bearing, yaw, speed,
  yaw rate, 5 range rays, battery, traction. Bounds violations raise.
- Action: `Box((2,), float32)` in [-1, 1] — left/right drive. Malformed
  (shape/finite) raises `ArkValidationError`; finite out-of-range values
  pass through and TypeScript clips them (`info["actionClipped"]`).
- `reset(seed, options)` — `options` supports `start`/`target` `{x, z}` and
  `split` ("train"/"eval"); omitted seed uses OS entropy server-side.
- Rewards, termination (`goal`/`battery-depleted`/`rollover`), and
  truncation (`max-steps`/`time-limit`/`out-of-bounds`) come from TypeScript
  untouched. `step()` after done raises until `reset()`.
- Constructor kwargs use snake_case (`max_steps`, `action_repeat`,
  `tolerance_m`, `terrain_subdivisions`, …) translated to the bridge
  payload; unknown keys pass through as-is. `seed=` is an alias for the
  fixed world seed `terrain_seed=`; per-episode seeds go to `reset()`.

## Multi-env and limits

One `ArkEnv` owns one bridge process (one physics world). For several envs
in one process, use `BridgeClient` directly (`create()` returns env ids, up
to 8 live). Requests are processed strictly sequentially. Full-episode
determinism holds per seed on one machine (Rapier state is rebuilt each
reset); bitwise cross-platform equality is not claimed.

## Colab training environment (Phase 6.4)

`notebooks/ARK_Colab_Setup.ipynb` installs ARK on a hosted Colab Linux
runtime and validates real physics end to end. Open it via Colab's
File → Upload notebook (or from GitHub once pushed), set `REPO_URL` in
section 2, then run top to bottom.

- `scripts/setup_colab.sh [clone|node|npm|python|all]` — idempotent setup
  stages. Requires Node >= 18 (installs 22 LTS only if older); `npm ci`
  from the lockfile; no TS build step (repo-local `tsx`). Honors
  `ARK_REPO_URL` / `ARK_REV` / `ARK_WORK_DIR`; never prints the URL.
- `scripts/verify_colab.py [--stage versions|planets|gym|benchmark|artifacts|all]`
  — canonical validation: version/commit record, Earth+Mars smoke tests
  (planet asserted from simulation metadata, motion measured from Rapier
  state), `gymnasium.check_env` (+ SB3's checker when installed), bounded
  throughput benchmark, and `colab_artifacts/ark_colab_diagnostics.json`.
- Local equivalent: `npm run colab:verify` (uses the uv venv).

Colab notes: Python deps install into the notebook kernel (uv venvs are
invisible to Colab cells); Gymnasium is pinned from `uv.lock`, NumPy floats
at `>=1.26` to keep Colab's build when compatible — exact versions land in
the artifacts. GPU is optional (physics is CPU). Push local 6.3/6.4 work
before running in Colab: the notebook asserts the checkout contains the
bridge and training scripts. Hosted-Colab execution itself was not run from
this machine; see the 6.4 report for the unverified-on-Colab list.
