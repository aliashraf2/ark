# ARK — Autonomous Reality Kernel

Physics-based Earth/Mars simulator (Three.js + Rapier) with AI Mission Control
(CSP-orchestrated natural-language environment control).

## Run everything (one command)

```bash
./scripts/dev.sh
```

Starts the agent backend (`:8000`) and the simulator (`:5173`, or the next
free port — watch the `[sim]` lines). Open the simulator URL in your browser,
go to the **Mission AI** tab, and paste a Gemini or Anthropic API key if the
Agent Link box asks for one. Ctrl-C stops everything.

Custom ports: `AGENT_PORT=8000 SIM_PORT=5173 ./scripts/dev.sh`

## Verify everything (one command)

```bash
./scripts/test.sh          # backend + web + headless determinism gate
./scripts/test.sh backend  # Python agent tests only
./scripts/test.sh web      # simulator tests + typecheck + build
./scripts/test.sh headless # headless sim determinism gate only
```

## Headless simulator (no browser)

```bash
npm run sim:headless -- --planet mars --seed 42 --steps 600
npm run sim:headless -- --steps 10000 --benchmark
npm run sim:headless -- --check-determinism
```

## Layout

- `apps/simulator/` — Svelte + Vite + Three.js + Rapier frontend
- `packages/physics/` — shared headless-safe simulation core (physics, terrain, worlds, robotics)
- `services/training/headless/` — Node CLI entry for the headless simulator
- `services/agent/` — FastAPI + CSP mission-control backend (see its README)
- `packages/shared/world-commands.json` — canonical world-command protocol
- `scripts/` — one-command dev/test launchers
