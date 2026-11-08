# ARK Mission Control backend (Milestone 4)

FastAPI + CSP-orchestrated natural-language interface to the ARK simulator.
The backend **proposes validated world commands**; the browser simulator
**executes them against real physics** and reports verified telemetry; the
backend then summarizes only what was verified.

## Credit: Capability Synthesis Protocol

Capability orchestration, planning, and sandboxed synthesis use the
pre-existing open-source [Capability Synthesis Protocol](https://github.com/ldbtech/capability-synthesis-protocol)
by ldbtech — credited separately from ARK code developed for the hackathon.
Pinned in `pyproject.toml`:

- `csp-sdk @ git rev 3fe6e7d20d00d8c49c1787db8fb1e5810bb4c349`

CSP is used through its public API only (`Orchestrator`, `@capability`,
`run_goal`, `call_capability`, `forget`, `BaseLLM`, `AnthropicLLM`,
`PythonSandbox`). No CSP source is copied into this repository.

## Setup (no venv dance)

```bash
cd services/agent
uv sync
uv run uvicorn app:app --port 8000
```

Then open the simulator (`apps/simulator`, `npm run dev`), go to the
**Mission AI** tab, and paste your API key in the **Agent Link** setup box.
The backend validates the key with a live probe, stores it in its local
gitignored `.env`, and hot-swaps the agent's brain — no restart, no terminal
editing. Gemini (Google AI Studio), Anthropic, and **Muse (Meta)** are supported;
keys can also be set as `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `MUSE_API_KEY`
in `.env`. `MODEL_API_KEY` is accepted as the official Meta environment alias.

For Muse, select **Muse (Meta)** in Agent Link and paste your Meta Model API key.
The default model is `muse-spark-1.3`; the optional model field can select another
text model available to your account. The adapter calls Meta's fixed
`https://api.meta.ai/v1/chat/completions` endpoint using bearer authentication,
as documented in the [Meta Chat Completions guide](https://dev.meta.ai/docs/protocols/chat-completions).
It implements CSP's existing `BaseLLM` interface, so typed and spoken requests
keep the same capability discovery, validation, approval and execution path.
The token budget includes an allowance for Muse reasoning, including the setup
probe. Provider errors, empty answers and truncated answers fail explicitly.

After successful dashboard setup, `ARK_LLM_PROVIDER` records your selection so
it remains active after restart even when another provider's key is present.
Without a selection, the legacy priority remains Gemini, Anthropic, then Muse.
Never place provider keys in browser environment variables or source code.
Muse HTTP mapping and dashboard setup are tested with mocked provider responses;
no live Muse API request was made without an account key.

The simulator calls this service at `http://localhost:8000`
(override with `VITE_AGENT_URL`).

For public hosting, use the [Vultr deployment launcher](../../deploy/vultr/README.md).
Production serves the UI and API from the same HTTPS origin, authenticates users
at the gateway, and keeps the backend port private. `ARK_PUBLIC_ORIGIN` enables
the backend's gateway-token/Host/Origin guard; it requires `ARK_PROXY_TOKEN`.
The launcher supplies both privately. Local development retains its localhost
voice guard. Do not expose the development Uvicorn port as a public dashboard.

## API

- `GET /api/health` — status, LLM configuration, provider/model, protocol version.
- `GET /api/mission/capabilities` — registered + approved capabilities.
- `POST /api/mission/configure` — validate + persist a pasted API key (UI setup).
- `POST /api/mission/interpret` — NL request + world snapshot → proposed
  actions / clarification / unsupported / missing-capability / synthesis proposal.
- `POST /api/mission/respond` — verified execution results + snapshot → summary.
- `POST /api/mission/approve_capability` — approve a pending synthesis (first
  activation always requires explicit approval).

## Safety model

- The LLM never touches physics: capabilities return validated command
  envelopes; the simulator re-validates and executes.
- Synthesized code runs once in CSP's sandboxed subprocess and may only
  produce a declarative composition spec; every step is re-validated against
  the canonical protocol (`packages/shared/world-commands.json`), and the
  capability stays unavailable until approved.
- CSP's own docs note its sandbox is process isolation, not a hard security
  boundary; acceptable for single-user localhost hackathon use.

## Tests

```bash
uv run pytest
```
