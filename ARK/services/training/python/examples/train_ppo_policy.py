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


def make_env(
    kind: str,
    seed: int,
    episode_steps: int,
    distance_range: tuple[float, float] | None = None,
    terrain_subdivisions: int = 160,
    terrain_profile: str = "cratered-plains",
):
    min_distance, max_distance = distance_range or (
        (12, 35) if kind == "rover" else (8, 28)
    )
    return Monitor(
        ArkEnv(
            planet="mars",
            seed=seed,
            agent_type=kind,
            max_steps=episode_steps,
            action_repeat=4,
            goal_min_distance_m=min_distance,
            goal_max_distance_m=max_distance,
            terrain_subdivisions=terrain_subdivisions,
            terrain_profile=terrain_profile,
        )
    )


def navigation_teacher_action(observation: np.ndarray) -> np.ndarray:
    """Mirror ARK's PD waypoint controller using its normalized rover sensors."""
    error = float(observation[1]) * np.pi
    yaw_rate = float(observation[4]) * 3.0
    turn = float(np.clip(error * 0.8 - yaw_rate * 1.2, -0.6, 0.6))
    forward_clearance_m = min(float(observation[6]), float(observation[7]), float(observation[8])) * 15.0
    clearance = float(np.clip(forward_clearance_m / 4.0, 0.0, 1.0))
    spin_gate = max(0.0, 1.0 - abs(yaw_rate) / 2.0)
    throttle = 0.4 * clearance * max(0.0, float(np.cos(error))) * spin_gate
    return np.asarray(
        [np.clip(throttle - turn, -1.0, 1.0), np.clip(throttle + turn, -1.0, 1.0)],
        dtype=np.float32,
    )


def collect_teacher_data(episodes: int, episode_steps: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    observations: list[np.ndarray] = []
    actions: list[np.ndarray] = []
    env = None
    try:
        for episode in range(episodes):
            if episode % 6 == 0:
                if env is not None:
                    env.close()
                env = make_env(
                    "rover", seed + episode * 101, episode_steps,
                    (4, 10), 64, "smooth-basin",
                )
            obs, _ = env.reset(seed=seed + episode)
            for _ in range(episode_steps):
                action = navigation_teacher_action(obs)
                observations.append(obs.copy())
                actions.append(action)
                obs, _reward, terminated, truncated, _info = env.step(action)
                if terminated or truncated:
                    break
    finally:
        if env is not None:
            env.close()
    return np.stack(observations), np.stack(actions)


def behavior_clone(model: PPO, observations: np.ndarray, actions: np.ndarray, epochs: int) -> float:
    """Initialize PPO's actor by supervised imitation of ARK's native controller."""
    device = model.device
    obs_tensor = torch.as_tensor(observations, dtype=torch.float32, device=device)
    action_tensor = torch.as_tensor(actions, dtype=torch.float32, device=device)
    actor_parameters = list(model.policy.mlp_extractor.policy_net.parameters()) + list(
        model.policy.action_net.parameters()
    )
    optimizer = torch.optim.Adam(actor_parameters, lr=3e-4)
    batch_size = min(512, len(observations))
    last_loss = 0.0
    for _ in range(epochs):
        for indices in torch.randperm(len(observations), device=device).split(batch_size):
            latent = model.policy.mlp_extractor.forward_actor(obs_tensor[indices])
            predicted = model.policy.action_net(latent)
            loss = torch.nn.functional.mse_loss(predicted, action_tensor[indices])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            last_loss = float(loss.detach().cpu())
    return last_loss


def evaluate(
    model: PPO,
    kind: str,
    episodes: int,
    episode_steps: int,
    seed: int,
    terrain_profile: str = "cratered-plains",
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    # Reuse a bridge process for several episodes on the same terrain. This
    # avoids paying Node/Rapier startup for every holdout while still checking
    # ten independent terrain seeds in a 60-episode evaluation.
    env = None
    try:
        for index in range(episodes):
            terrain_group = index // 6
            if index % 6 == 0:
                if env is not None:
                    env.close()
                env = make_env(
                    kind,
                    seed + 100_000 + terrain_group * 1_000,
                    episode_steps,
                    terrain_profile=terrain_profile,
                )
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
        if env is not None:
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
    parser.add_argument(
        "--no-curriculum",
        action="store_true",
        help="Train directly on the full deployment distance range.",
    )
    parser.add_argument(
        "--eval-only-checkpoint",
        type=Path,
        help="Skip training; evaluate and export an existing SB3 checkpoint.",
    )
    parser.add_argument(
        "--behavior-cloning-episodes",
        type=int,
        default=0,
        help="Warm-start rover PPO from ARK's waypoint controller before RL fine-tuning.",
    )
    parser.add_argument("--behavior-cloning-epochs", type=int, default=15)
    args = parser.parse_args()
    if (
        args.steps <= 0 or args.eval_episodes <= 0 or args.episode_steps <= 0
        or args.behavior_cloning_episodes < 0 or args.behavior_cloning_epochs <= 0
    ):
        parser.error("steps, eval-episodes, and episode-steps must be positive; behavior-cloning-episodes must be non-negative")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    name = f"ark_{args.agent}_ppo_mars"
    model_path = args.output_dir / name
    policy_path = args.output_dir / f"{name}.json"
    started = time.perf_counter()
    behavior_cloning_metrics: dict[str, Any] | None = None
    if args.agent == "rover":
        curriculum = [
            (0.20, (4, 10), 64, "smooth-basin"),
            (0.25, (6, 15), 96, "smooth-basin"),
            (0.25, (8, 22), 128, "cratered-plains"),
            (0.30, (12, 35), 160, "cratered-plains"),
        ]
    else:
        curriculum = [
            (0.30, (4, 12), 64, "smooth-basin"),
            (0.30, (8, 18), 96, "smooth-basin"),
            (0.40, (8, 28), 160, "smooth-basin"),
        ]
    if args.no_curriculum:
        curriculum = [(1.0, (12, 35) if args.agent == "rover" else (8, 28), 160, "cratered-plains")]

    env = make_env(
        args.agent,
        args.seed,
        args.episode_steps,
        curriculum[0][1],
        curriculum[0][2],
        curriculum[0][3],
    )
    try:
        trained = 0
        curriculum_history = []
        if args.eval_only_checkpoint:
            model = PPO.load(str(args.eval_only_checkpoint), env=env, device="cpu")
            trained = int(model.num_timesteps)
        else:
            model = PPO(
                "MlpPolicy", env, seed=args.seed, device="cpu", verbose=1,
                learning_rate=1.5e-4, n_steps=2048, batch_size=256,
                n_epochs=10, gamma=0.995, gae_lambda=0.95,
                ent_coef=0.003, vf_coef=0.5, max_grad_norm=0.5,
                policy_kwargs={"net_arch": {"pi": [128, 128], "vf": [128, 128]}, "log_std_init": -1.0},
            )
            if args.agent == "rover" and args.behavior_cloning_episodes:
                teacher_obs, teacher_actions = collect_teacher_data(
                    args.behavior_cloning_episodes, args.episode_steps, args.seed + 700_000
                )
                last_loss = behavior_clone(
                    model, teacher_obs, teacher_actions, args.behavior_cloning_epochs
                )
                behavior_cloning_metrics = {
                    "teacher": "ark_navigation_controller",
                    "terrain_profile": "smooth-basin",
                    "distance_range_m": [4, 10],
                    "episodes": args.behavior_cloning_episodes,
                    "samples": len(teacher_obs),
                    "epochs": args.behavior_cloning_epochs,
                    "final_mse": last_loss,
                }
                model.save(str(args.output_dir / f"{name}_behavior_cloned"))
            for stage, (fraction, distance_range, terrain_subdivisions, terrain_profile) in enumerate(curriculum):
                stage_steps = (
                    args.steps - trained
                    if stage == len(curriculum) - 1
                    else int(args.steps * fraction)
                )
                if stage > 0:
                    env.close()
                    env = make_env(
                        args.agent,
                        args.seed + stage * 1009,
                        args.episode_steps,
                        distance_range,
                        terrain_subdivisions,
                        terrain_profile,
                    )
                    model.set_env(env)
                model.learn(
                    total_timesteps=stage_steps,
                    progress_bar=False,
                    reset_num_timesteps=False,
                )
                trained += stage_steps
                stage_eval = evaluate(
                    model,
                    args.agent,
                    min(12, args.eval_episodes),
                    args.episode_steps,
                    args.seed + 500_000 + stage * 10_000,
                    terrain_profile,
                )
                curriculum_history.append({
                    "stage": stage + 1,
                    "distance_range_m": list(distance_range),
                    "terrain_subdivisions": terrain_subdivisions,
                    "terrain_profile": terrain_profile,
                    "timesteps": trained,
                    "holdout_success_rate": stage_eval["success_rate"],
                    "holdout_mean_final_distance_m": stage_eval["mean_final_distance_m"],
                })
                model.save(str(args.output_dir / f"{name}_stage_{stage + 1}"))
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
        "curriculum": curriculum_history,
        "behavior_cloning": behavior_cloning_metrics,
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
