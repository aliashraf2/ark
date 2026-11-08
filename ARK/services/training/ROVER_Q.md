# Fast rover experiment

Branch: `feature/rover-sprint`. Separate worktree: `ark-rover-sprint`.
The original `ark` checkout and its processes on 5173/8000 are untouched.

From this checkout's inner `ARK` directory:

```bash
npm run rover:train -- --seconds 45 --episodes 400 --eval-episodes 40 --eval-seed 2000000
npm run rover:dev
```

Preview: http://localhost:5175 (agent: http://localhost:8001). Node dependencies
and the Python venv belong to this worktree. Agent configuration/data are isolated
under ignored `.dev-rover/`. Link an LLM in this preview's Agent Link panel.
The preview requires those exact ports; it does not move onto 5173 if busy.

## What is learned

Tabular Q-learning selects among five bounded sets of the existing navigation
controller's gains: cautious, standard, brisk, stronger heading correction and
stronger yaw damping. It does not learn a new physics model or raw wheel torque.
The state bins goal bearing, speed, yaw rate, goal distance and front clearance
from the existing twelve-value observation. Decisions occur every eight physics
steps (7.5 Hz); the existing controller executes at 60 Hz in both training and
the browser. Unseen states use standard waypoint gains. Arrival still brakes.

Training runs in Node directly over the existing RoverEnv/Rapier simulation;
there is no GPU, neural network or per-step Python/JSON bridge. It uses seeded
exploration and Q updates from real transitions. Learning emphasizes progress
(environment reward plus nine additional progress terms, minus 100 on rollover).
Evaluation uses unmodified environment rewards and freezes the table. This is
ordinary Q-learning; no simulated experience/replay or LLM-generated rewards.
See [Sutton and Barto, chapter 6](https://www.incompleteideas.net/book/bookdraft2018mar21.pdf).

## Measured result and limits

The saved final checkpoint trained for **45.00 seconds**. All forty evaluation
seeds start at 2,000,000 and are separate from training seeds starting at 1,000.
Each controller gets the same scenarios and limits: Mars cratered-plains,
terrain seed 42, full 160-cell terrain, sampled 5–12 meter goals, two-meter
arrival tolerance, at most 900 decisions / 120 simulated seconds.

| Controller | Completed | Mean environment return |
| --- | --- | --- |
| Q-learning navigation options | 3/40 (7.5%) | -26.87 |
| Existing waypoint navigation | 4/40 (10%) | -25.63 |
| Existing browser PPO-assisted controller | 0/40 (0%) | -55.79 |

These rates are low and are not deployment qualification. Q-learning improves
on the existing PPO-assisted controller in this sample, but **does not beat
waypoint navigation**. Longer-range goals in the initial experiment failed for
all three controllers. Earth, unseen terrain seeds, weather, mission distances
outside the curriculum and multi-rover cooperation are unverified. Forty seeds
on one terrain do not establish statistical superiority/generalization.

The default for new missions is waypoint control. Select a rover and click
**Q-learning Rover** on Mars to opt into the experimental controller, then issue
a mission. Automatic Q selection requires at least forty evaluation episodes
and a better measured success rate than waypoint control. Manual PPO remains
available. Drones and their policies are unchanged.

Artifacts: `packages/rl/policies/rover-q-mars.json` (table and summary) and
`services/training/results/rover-q-mars-evaluation.json` (all episode results,
training seed range, timing, reward definition and configuration). Training is
bounded by the wall-clock budget; evaluation runs afterward. CPU load can change
how many episodes fit within the budget. Reproduce exact training data by using
an episode limit and a generous time budget. Retraining overwrites artifacts;
an already-open preview should be reloaded afterward.

## LLM connection

Mission Control still discovers `assign_rover_mission` through CSP, validates
its task and coordinates, and requires operator confirmation. Confirmed rover
commands select the opted-in Q controller or baseline in App.svelte. Telemetry
snapshots include `roverLearning` with the real checkpoint evaluation; the LLM
is told that these are historical evaluation results, never live completion.
Driving runs locally with no LLM calls per step. LLM requests cannot retrain,
rewrite rewards, bypass validation or turn a proposal into a claimed success.
The existing voice interface follows this same route. Provider requests were
mocked in tests; no live LLM API call or browser microphone test is claimed.

Validation: frontend suite, backend suite (including fake-LLM confirmed mission
proposals), typecheck and production build; real headless Rapier training and
controller comparison. HTTP checks cover the separate preview/backend. An
interactive browser session was unavailable to the automation tools.
