#!/usr/bin/env python3
"""Train, evaluate, and export deployable rover or drone PPO policies."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import gymnasium
import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.monitor import Monitor

from ark_gym import ArkEnv


def export_policy(model: PPO, kind: str, steps: int, output: Path, evaluation: dict[str, Any]) -> None:
    policy = model.policy
    layers = [layer for layer in policy.mlp_extractor.policy_net if isinstance(layer, torch.nn.Linear)]
    hidden_layers = layers
    action_layer = policy.action_net

    def serialise(layer: torch.nn.Linear) -> dict[str, list[list[float]] | list[float]]:
        return {
            "weights": layer.weight.detach().cpu().numpy().astype(float).tolist(),
            "bias": layer.bias.detach().cpu().numpy().astype(float).tolist(),
        }

    policy_json = {
        "format": "ark-ppo-mlp-v1" if kind == "rover" else "ark-ppo-drone-mlp-v1",
        "agent": kind,
        "planet": "mars",
        "trainedTimesteps": steps,
        "evaluationEpisodes": evaluation["episodes"],
        "evaluationSuccessRate": evaluation["success_rate"],
        "observationSize": model.observation_space.shape[0],
        "actionSize": model.action_space.shape[0],
        "activation": "tanh",
        "hiddenLayers": [serialise(layer) for layer in hidden_layers],
        "actionLayer": serialise(action_layer),
    }
    output.write_text(json.dumps(policy_json, separators=(",", ":")) + "\n")


def make_env(kind: str, seed: int, episode_steps: int):
    return Monitor(
        ArkEnv(
            planet="mars",
            seed=seed,
            agent_type=kind,
            max_steps=episode_steps,
            action_repeat=4,
            goal_min_distance_m=12 if kind == "rover" else 8,
            goal_max_distance_m=35 if kind == "rover" else 28,
        )
    )


def evaluate(model: PPO, kind: str, episodes: int, episode_steps: int, seed: int) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    for index in range(episodes):
        env = make_env(kind, seed + 100_000 + index, episode_steps)
        try:
            obs, _ = env.reset(seed=seed + 100_000 + index)
            total_reward = 0.0
            for step in range(episode_steps):
                action, _ = model.predict(obs, deterministic=True)
                obs, reward, terminated, truncated, info = env.step(action)
                total_reward += float(reward)
                if terminated or truncated:
                    break
            metrics = info.get("metrics", {})
            records.append({
                "success": bool(metrics.get("success", False)),
                "reward": total_reward,
                "length": int(metrics.get("length", step + 1)),
                "final_distance_m": metrics.get("finalDistanceM"),
                "termination_reason": metrics.get("terminationReason"),
                "truncation_reason": metrics.get("truncationReason"),
            })
        finally:
            env.close()
    successes = sum(record["success"] for record in records)
    return {
        "episodes": episodes,
        "successful_episodes": successes,
        "success_rate": successes / episodes if episodes else 0,
        "mean_reward": float(np.mean([record["reward"] for record in records])) if records else 0,
        "mean_final_distance_m": float(np.mean([record["final_distance_m"] or 0 for record in records])) if records else 0,
        "episode_metrics": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", choices=("rover", "drone"), required=True)
    parser.add_argument("--steps", type=int, default=500_000)
    parser.add_argument("--eval-episodes", type=int, default=60)
    parser.add_argument("--episode-steps", type=int, default=600)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=Path, default=Path("colab_artifacts/ppo_policy"))
    args = parser.parse_args()
    if args.steps <= 0 or args.eval_episodes <= 0 or args.episode_steps <= 0:
        parser.error("steps, eval-episodes, and episode-steps must be positive")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    name = f"ark_{args.agent}_ppo_mars"
    model_path = args.output_dir / name
    policy_path = args.output_dir / f"{name}.json"
    started = time.perf_counter()
    env = make_env(args.agent, args.seed, args.episode_steps)
    try:
        model = PPO(
            "MlpPolicy", env, seed=args.seed, device="cpu", verbose=1,
            learning_rate=2.5e-4, n_steps=1024, batch_size=128,
            n_epochs=10, gamma=0.995, gae_lambda=0.95,
            ent_coef=0.01, vf_coef=0.5, max_grad_norm=0.5,
            policy_kwargs={"net_arch": {"pi": [128, 128], "vf": [128, 128]}},
        )
        model.learn(total_timesteps=args.steps, progress_bar=False)
        actual_steps = int(model.num_timesteps)
        evaluation = evaluate(model, args.agent, args.eval_episodes, args.episode_steps, args.seed)
        model.save(str(model_path))
        export_policy(model, args.agent, actual_steps, policy_path, evaluation)
    finally:
        env.close()

    metrics = {
        "agent": args.agent,
        "planet": "mars",
        "seed": args.seed,
        "requested_timesteps": args.steps,
        "actual_timesteps": actual_steps,
        "episode_step_limit": args.episode_steps,
        "evaluation": evaluation,
        "wall_seconds": round(time.perf_counter() - started, 3),
        "model_file": f"{name}.zip",
        "browser_policy_file": policy_path.name,
        "versions": {"torch": torch.__version__, "gymnasium": gymnasium.__version__},
    }
    metrics_path = args.output_dir / f"{args.agent}_training_metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
