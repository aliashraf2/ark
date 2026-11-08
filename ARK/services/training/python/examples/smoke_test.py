#!/usr/bin/env python3
"""ARK bridge smoke test: one random-policy episode on real Rapier physics.

Run from the repo root (uv manages the env, no manual activation):

    npm run bridge:smoke

or directly:

    uv run --project services/training/python --group dev \
        services/training/python/examples/smoke_test.py
"""

import numpy as np

from ark_gym import ArkEnv


def main() -> None:
    print("ARK bridge smoke: random agent, one episode on real physics")
    env = ArkEnv(planet="mars", seed=42)
    try:
        print(f"observation_space: {env.observation_space}")
        print(f"action_space: {env.action_space}")
        obs, info = env.reset(seed=123)
        print(f"scenario: {info['scenario']['scenarioId']}")
        assert obs.shape == (12,) and np.all(np.isfinite(obs))

        result = None
        for step in range(1, 602):  # default max_steps=600 guarantees truncation
            action = env.action_space.sample()
            obs, reward, terminated, truncated, info = env.step(action)
            result = (reward, terminated, truncated, info)
            if step % 100 == 0 or terminated or truncated:
                m = info["metrics"]
                print(
                    f"step {step}: reward={reward:+.3f} total={m['episodeReward']:+.2f} "
                    f"dist={info['distanceM']:.1f}m traveled={m['distanceTraveledM']:.1f}m"
                )
            if terminated or truncated:
                break
        assert result is not None
        reward, terminated, truncated, info = result
        assert terminated or truncated, "episode did not end within the step cap"
        assert np.isfinite(info["metrics"]["episodeReward"])
        m = info["metrics"]
        print(
            f"done: {'terminated' if terminated else 'truncated'} "
            f"({m['terminationReason'] or m['truncationReason']}) "
            f"length={m['length']} collisions={m['collisions']}"
        )
        env.reset(seed=124)
        env.step(np.zeros(2, dtype=np.float32))
        print("SMOKE: PASS")
    finally:
        env.close()


if __name__ == "__main__":
    main()
