# @ark/rl — ARK Reinforcement Learning Environment API

Gymnasium-style `reset()` / `step()` interface driving ARK's existing Rapier
rover. Headless (no rendering), deterministic under fixed seeds, and built for
a future Python bridge — no Python here.

```ts
import { createArkEnvironment } from './src/index.js'

const env = await createArkEnvironment({ planet: 'mars', terrainSeed: 42 })
let { observation, info } = env.reset(7)
console.log(info.scenario.scenarioId) // mars:t42:e7:train
let done = false
while (!done) {
  const result = env.step({ leftDrive: 1, rightDrive: 0.8 })
  observation = result.observation
  done = result.terminated || result.truncated
}
console.log(result.info.metrics)
env.close()
```

## Observation (Float32Array, length 12)

All values finite within their documented ranges; canonical order in
`OBSERVATION_SPEC` (`packages/rl/src/observations/observationSpec.ts`):

| Idx | Name | Meaning |
| --- | ---- | ------- |
| 0 | targetDistanceNorm | Goal distance / 100 m, clipped [0, 1] |
| 1 | targetBearingNorm | Goal bearing / π, robot-local, [-1, 1] |
| 2 | headingNorm | World yaw / π, [-1, 1] |
| 3 | speedNorm | Horizontal speed / 8 m/s, clipped [0, 1] |
| 4 | yawRateNorm | Yaw rate / 3 rad/s, clipped [-1, 1] |
| 5–9 | ray0..ray4 | 5 obstacle-ray distances / max range, robot-local fan, [0, 1] |
| 10 | batteryNorm | Charge fraction, clamped [0, 1] |
| 11 | tractionNorm | Traction estimate / 1.5, clamped [0, 1] |

Agent observation only — privileged ground truth (positions, mission state)
stays in `info`/physics and out of the policy input. Divergence from the
original 15-field sketch is deliberate: goal direction is polar
(distance + bearing), lateral velocity is folded into speed, and slope is
enforced by scenario generation (gentle ground) rather than sensed. Bounds:
`observationBounds()`.

## Action

`{ leftDrive, rightDrive }`, each continuous in [-1, 1], mapped 1:1 onto the
shared differential-drive actuator (brake/eStop stay false — no brake
channel in v1; zero throttle coasts against rolling resistance).

Validation policy (fail fast, Gymnasium-Box-compatible):

- Missing / non-object / non-number / NaN / Infinite fields → **throw**.
- Finite values outside [-1, 1] → **clipped**, reported as
  `info.actionClipped: true`.

The physics actuator validates again (fail-safe brake), belt and suspenders.

## Stepping

- Physics dt is fixed at 1/60 s; each RL step applies the action for
  `actionRepeat` substeps (default 4 → 15 Hz control).
- `step()` returns `{ observation, reward, terminated, truncated, info }`.
- `step()` before the first `reset()`, after `close()`, or after the episode
  ended without `reset()` **throws**.
- `physicsSteps` / `simTimeS` in `info` report exact simulated progress.

## Reward

Pure `navigationReward` (see `packages/physics/src/robotics/RoverDynamics.ts`):

    r = progress + successBonus + collisionPenalty + energyPenalty + timePenalty

with `progress = w.progress × (d_prev − d)` (meters gained toward goal),
`successBonus = w.success` on arrival, `collisionPenalty = w.collision` while
any forward ray reads < 0.6 m, `energyPenalty = w.energy × Joules`,
`timePenalty = w.time × dt`. Defaults: progress 2, success 100,
collision −5, energy −0.01, time −0.2; all configurable. Per-term values are
in `info.rewardTerms` every step.

Known limitation: "collision" is a forward-ray proximity proxy (< 0.6 m),
not a Rapier contact event — there are no obstacle bodies in v1 scenarios,
and steep upslope ground can read as proximity. True contact-based collision
is future work.

## Termination vs truncation

- `terminated`: `goal` (within tolerance), `battery-depleted` (charge 0),
  `rollover` (body up-axis Y < 0.5, i.e. tilt past 60°).
- `truncated`: `max-steps` (RL step cap), `time-limit` (mission sim-seconds),
  `out-of-bounds` (left the episode patch).
- Reasons in `info.metrics.terminationReason` / `.truncationReason`;
  `success` is true only for `goal`.

## Reset and scenarios

`reset(episodeSeed?, { start?, target?, split? })` → `{ observation, info }`.
Omitted seed uses OS entropy. Generated scenarios pick a gentle spawn site
(spiral search, ≤ 15°) facing downhill plus a goal on gentle ground (≤ 19°)
inside the configured distance band; `info.scenario` records the id, seeds,
split, both points, both slopes, and `constraintsMet`. Explicit start/target
overrides skip the sampler (still slope-reported). Train/eval separation is
by seed range: train < 1e9, eval via `evalEpisodeSeed(n)` ≥ 1e9.

Limitation: gentle ground is verified, but reachability is NOT — no path
planner checks that start can reach the goal. Keep bands modest.

## Metrics

Every `info.metrics`: episode reward sum, length, success, final distance,
traveled distance (position deltas), collision steps, energy (J), and both
reasons. Serialized from plain numbers — no Rapier handles cross the API.

## Phase 6.3 notes

- `observationBounds()` / `actionBounds()` give Box low/high arrays.
- Observations are fixed-size `Float32Array`; infos are JSON-safe.
- Seeds: `terrainSeed` fixes the world, `episodeSeed` fixes the scenario;
  same pair ⇒ identical initial observation (tested).
- Bitwise cross-platform equality is NOT claimed (WASM float determinism is
  same-machine in practice).
