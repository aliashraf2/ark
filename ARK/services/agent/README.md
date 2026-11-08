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
editing. Gemini (Google AI Studio) and Anthropic are supported; keys can also
be set directly as `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` in `.env`.

The simulator calls this service at `http://localhost:8000`
(override with `VITE_AGENT_URL`).

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
