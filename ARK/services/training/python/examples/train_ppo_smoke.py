#!/usr/bin/env python3
"""Train a small PPO rover policy against the real ARK physics bridge.

Intended for a short Colab CPU smoke run, not a converged rover policy.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import gymnasium
import numpy
import stable_baselines3
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv

from ark_gym import ArkEnv


class EpisodeMetrics(BaseCallback):
    def __init__(self) -> None:
        super().__init__()
        self.episodes: list[dict] = []

    def _on_step(self) -> bool:
        for done, info in zip(self.locals["dones"], self.locals["infos"]):
            if not done:
                continue
            metrics = info.get("metrics", {})
            self.episodes.append(
                {
                    "reward": metrics.get("episodeReward"),
                    "length": metrics.get("length"),
                    "success": metrics.get("success", False),
                    "termination_reason": metrics.get("terminationReason"),
                    "truncation_reason": metrics.get("truncationReason"),
                    "final_distance_m": metrics.get("finalDistanceM"),
                    "distance_traveled_m": metrics.get("distanceTraveledM"),
                }
            )
        return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", type=int, default=5_000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--planet", choices=("earth", "mars"), default="mars")
    parser.add_argument("--episode-steps", type=int, default=300)
    parser.add_argument("--output-dir", type=Path, default=Path("colab_artifacts/ppo_smoke"))
    args = parser.parse_args()
    if args.steps <= 0 or args.episode_steps <= 0:
        parser.error("--steps and --episode-steps must be positive")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    model_path = args.output_dir / f"ark_rover_ppo_{args.planet}_smoke"
    env = DummyVecEnv(
        [
            lambda: Monitor(
                ArkEnv(planet=args.planet, seed=args.seed, max_steps=args.episode_steps)
            )
        ]
    )
    callback = EpisodeMetrics()
    started = time.perf_counter()
    try:
        model = PPO(
            "MlpPolicy",
            env,
            n_steps=512,
            batch_size=64,
            learning_rate=3e-4,
            gamma=0.99,
            seed=args.seed,
            device="cpu",
            verbose=1,
        )
        model.learn(total_timesteps=args.steps, callback=callback, progress_bar=False)
        actual_timesteps = int(model.num_timesteps)
        model.save(str(model_path))
    finally:
        env.close()

    elapsed = time.perf_counter() - started
    completed = callback.episodes
    rewards = [e["reward"] for e in completed if e["reward"] is not None]
    result = {
        "run_type": "smoke",
        "warning": "Short PPO smoke run; this does not establish policy convergence.",
        "planet": args.planet,
        "seed": args.seed,
        "requested_timesteps": args.steps,
        "actual_timesteps": actual_timesteps,
        "episode_step_limit": args.episode_steps,
        "wall_seconds": round(elapsed, 3),
        "episodes_completed": len(completed),
        "successful_episodes": sum(bool(e["success"]) for e in completed),
        "success_rate": round(
            sum(bool(e["success"]) for e in completed) / len(completed), 4
        )
        if completed
        else None,
        "mean_episode_reward": round(float(numpy.mean(rewards)), 4) if rewards else None,
        "episode_metrics": completed,
        "model_file": model_path.with_suffix(".zip").name,
        "versions": {
            "python_torch": torch.__version__,
            "stable_baselines3": stable_baselines3.__version__,
            "gymnasium": gymnasium.__version__,
            "numpy": numpy.__version__,
        },
    }
    metrics_path = args.output_dir / "training_metrics.json"
    metrics_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    print(f"model: {model_path}.zip")
    print(f"metrics: {metrics_path}")


if __name__ == "__main__":
    main()
