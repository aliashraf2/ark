#!/usr/bin/env python3
"""ARK Colab verification: versions, planet smoke tests, Gymnasium checks,
benchmark, and diagnostic artifacts. Runs against REAL Rapier physics through
the persistent Node.js bridge — no mocks, no synthetic rewards.

Run from the repo root with the project venv:
    uv run --project services/training/python --group dev \
        services/training/scripts/verify_colab.py [--stage all] [--output-dir DIR]

Exit code is nonzero on any failure, with an explicit error message.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = SCRIPT_DIR.parents[2]  # services/training/scripts -> repo root

RESULTS: dict = {"checks": []}


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS["checks"].append({"name": name, "ok": ok, "detail": detail})
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        raise SystemExit(f"FAILED: {name} — {detail}")


def run(cmd: list[str], cwd: Path | None = None) -> str:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise SystemExit(f"Command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr[-2000:]}")
    return proc.stdout.strip()


# -- stage: versions -----------------------------------------------------------

def stage_versions(repo_root: Path) -> dict:
    print("== versions ==")
    import gymnasium
    import numpy
    import ark_gym

    node = run(["node", "--version"])
    npm = run(["npm", "--version"])
    rapier = run(
        ["node", "-p", "require('./node_modules/@dimforge/rapier3d-compat/package.json').version"],
        cwd=repo_root,
    )
    commit = run(["git", "rev-parse", "HEAD"], cwd=repo_root)
    versions = {
        "node": node,
        "npm": npm,
        "python": platform.python_version(),
        "rapier3d-compat": rapier,
        "gymnasium": gymnasium.__version__,
        "numpy": numpy.__version__,
        "ark_gym": ark_gym.__version__,
        "repo_commit": commit,
        "platform": platform.platform(),
    }
    check("node >= 18", int(node.lstrip("v").split(".")[0]) >= 18, node)
    check("ark_gym importable", True, f"v{ark_gym.__version__}")
    print(json.dumps(versions, indent=2))
    return versions


# -- stage: planets ------------------------------------------------------------

def smoke_planet(planet: str, seed: int) -> dict:
    import numpy as np
    from ark_gym import ArkEnv

    env = ArkEnv(planet=planet, seed=seed)
    try:
        check(f"{planet}: spaces", env.observation_space.shape == (12,) and env.action_space.shape == (2,),
              f"obs{env.observation_space.shape} act{env.action_space.shape}")
        obs, info = env.reset(seed=seed)
        # Planet identity from simulation metadata, not from a printed label.
        check(f"{planet}: metadata", info["scenario"]["planet"] == planet,
              info["scenario"]["scenarioId"])
        check(f"{planet}: initial obs valid", obs.shape == (12,) and bool(np.all(np.isfinite(obs))))
        # Drive forward: proves real Rapier motion (position deltas, energy burn).
        for _ in range(20):
            obs, reward, term, trunc, info = env.step(np.ones(2, dtype=np.float32))
            assert np.isfinite(reward) and isinstance(term, bool) and isinstance(trunc, bool)
            if term or trunc:
                obs, info = env.reset()
        m = info["metrics"]
        check(f"{planet}: real motion", m["distanceTraveledM"] > 0 and m["energyJ"] > 0,
              f"traveled={m['distanceTraveledM']:.2f}m energy={m['energyJ']:.1f}J")
        # Random episode with reset-on-done.
        steps = 0
        for _ in range(100):
            obs, reward, term, trunc, info = env.step(env.action_space.sample())
            steps += 1
            assert obs.dtype == np.float32 and np.all(np.isfinite(obs))
            if term or trunc:
                obs, info = env.reset()
        check(f"{planet}: 100-step random rollout", True, f"final dist={info['distanceM']:.1f}m")
        return {"planet": planet, "steps": steps + 20, "final_distance_m": info["distanceM"],
                "traveled_m": info["metrics"]["distanceTraveledM"]}
    finally:
        env.close()


def stage_planets(seed: int, only_planet: str | None = None) -> dict:
    print("== planets ==")
    planets = [only_planet] if only_planet else ["earth", "mars"]
    return {planet: smoke_planet(planet, seed) for planet in planets}


# -- stage: gym ----------------------------------------------------------------

def stage_gym() -> dict:
    print("== gymnasium validation ==")
    import gymnasium.utils.env_checker as checker
    from ark_gym import ArkEnv

    env = ArkEnv(planet="earth", terrain_seed=11, terrain_subdivisions=32,
                 max_steps=50, goal_min_distance_m=10, goal_max_distance_m=20)
    try:
        checker.check_env(env, skip_render_check=True)
    finally:
        env.close()
    check("gymnasium check_env", True)
    out: dict = {"gymnasium_check_env": "pass", "sb3_check_env": "skipped (not installed)"}
    try:
        from stable_baselines3.common.env_checker import check_env as sb3_check
    except ImportError:
        print("stable_baselines3 not installed; skipping SB3 checker (optional).")
        return out
    env = ArkEnv(planet="mars", terrain_seed=12, terrain_subdivisions=32, max_steps=50)
    try:
        sb3_check(env)
    finally:
        env.close()
    check("sb3 check_env", True)
    out["sb3_check_env"] = "pass"
    return out


# -- stage: benchmark ----------------------------------------------------------

def stage_benchmark(seed: int, steps: int) -> dict:
    print("== benchmark ==")
    import numpy as np
    from ark_gym import ArkEnv

    def cpu_model() -> str:
        if os.path.exists("/proc/cpuinfo"):
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if "model name" in line:
                    return line.split(":", 1)[1].strip()
        return platform.processor() or "unknown"

    def mem_total_gb() -> float | None:
        if os.path.exists("/proc/meminfo"):
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    return round(int(line.split()[1]) / 1e6, 2)
        return None

    env = ArkEnv(planet="mars", seed=seed)
    try:
        rng = np.random.default_rng(seed)
        env.reset(seed=seed)
        for _ in range(50):  # warmup, not timed
            _, _, term, trunc, _ = env.step(rng.uniform(-1, 1, size=2).astype(np.float32))
            if term or trunc:
                env.reset()
        reset_times = []
        for i in range(5):
            t0 = time.perf_counter()
            env.reset(seed=seed + i)
            reset_times.append(time.perf_counter() - t0)
        rl_steps = 0
        episodes = 0
        t0 = time.perf_counter()
        while rl_steps < steps:
            _, _, term, trunc, _ = env.step(rng.uniform(-1, 1, size=2).astype(np.float32))
            rl_steps += 1
            if term or trunc:
                episodes += 1
                env.reset()
        wall = time.perf_counter() - t0
    finally:
        env.close()
    # 4 physics substeps per RL step + 30 settle steps per reset (documented core constants).
    physics_steps = rl_steps * 4 + (episodes + 6) * 30
    bench = {
        "rl_steps": rl_steps,
        "physics_steps_est": physics_steps,
        "episodes_completed": episodes,
        "wall_s": round(wall, 3),
        "rl_steps_per_s": round(rl_steps / wall, 1),
        "physics_steps_per_s_est": round(physics_steps / wall, 1),
        "avg_reset_ms": round(sum(reset_times) / len(reset_times) * 1000, 2),
        "cpu": cpu_model(),
        "cpu_count": os.cpu_count(),
        "mem_total_gb": mem_total_gb(),
        "python": platform.python_version(),
    }
    check("benchmark throughput > 100 RL steps/s", bench["rl_steps_per_s"] > 100,
          f"{bench['rl_steps_per_s']} RL steps/s")
    print(json.dumps(bench, indent=2))
    return bench


# -- stage: artifacts ----------------------------------------------------------

def record(output_dir: Path, payload: dict) -> Path:
    """Incrementally persist stage results so the notebook can run stages
    across cells and still assemble one complete artifact."""
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "ark_colab_diagnostics.json"
    merged = dict(payload)
    if path.is_file():
        try:
            existing = json.loads(path.read_text())
            for key, value in payload.items():
                # One-level deep merge: sequential --only-planet runs accumulate.
                if isinstance(value, dict) and isinstance(existing.get(key), dict):
                    existing[key] = {**existing[key], **value}
                else:
                    existing[key] = value
            merged = existing
        except json.JSONDecodeError:
            pass
    path.write_text(json.dumps(merged, indent=2))
    return path


def stage_artifacts(repo_root: Path, output_dir: Path, payload: dict) -> Path:
    print("== artifacts ==")
    payload["saved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    path = record(output_dir, payload)
    check("diagnostics written", path.is_file(), str(path))
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description="ARK Colab verification (real physics).")
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--stage", choices=["versions", "planets", "gym", "benchmark", "artifacts", "all"],
                        default="all")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--steps", type=int, default=300)
    parser.add_argument("--only-planet", choices=["earth", "mars"], default=None)
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    if not (repo_root / "services" / "training" / "bridge" / "server.ts").is_file():
        raise SystemExit(f"Not an ARK checkout (bridge missing): {repo_root}")
    os.environ.setdefault("ARK_REPO_ROOT", str(repo_root))
    output_dir = args.output_dir or (repo_root / "colab_artifacts")

    payload: dict = {"repo_root": str(repo_root), "seed": args.seed}
    stages = ["versions", "planets", "gym", "benchmark", "artifacts"] if args.stage == "all" else [args.stage]
    # Artifacts alone just writes whatever was collected (versions always included).
    if stages == ["artifacts"]:
        payload["versions"] = stage_versions(repo_root)
        stage_artifacts(repo_root, output_dir, payload)
        return
    for stage in stages:
        if stage == "versions":
            payload["versions"] = stage_versions(repo_root)
        elif stage == "planets":
            new = stage_planets(args.seed, args.only_planet)
            payload["planets"] = {**payload.get("planets", {}), **new}
        elif stage == "gym":
            payload["gym"] = stage_gym()
        elif stage == "benchmark":
            payload["benchmark"] = stage_benchmark(args.seed, args.steps)
        elif stage == "artifacts":
            stage_artifacts(repo_root, output_dir, payload)
            continue
        record(output_dir, payload)
    print(f"\nAll requested stages passed: {', '.join(stages)}.")


if __name__ == "__main__":
    main()
