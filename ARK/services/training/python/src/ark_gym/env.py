"""Gymnasium adapter over ARK's Rapier rover simulation.

ArkEnv owns one persistent Node.js bridge process (one physics world) and
exposes it through the standard gymnasium.Env API. All physics, observations,
and rewards are computed in TypeScript; this module only adapts types and
conventions — it never simulates.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .client import BridgeClient
from .exceptions import ArkProtocolError, ArkValidationError

# Tolerance for observation bound checks (JSON round-trips float32 exactly, so
# any larger deviation is a genuine contract violation worth surfacing).
_BOUNDS_EPS = 1e-6

# snake_case constructor kwargs -> bridge (camelCase) create-payload keys.
# Unknown kwargs pass through untouched as an escape hatch for future keys.
_CONFIG_KEYS: dict[str, str] = {
    "terrain_seed": "terrainSeed",
    "action_repeat": "actionRepeat",
    "max_steps": "maxSteps",
    "time_limit_s": "timeLimitS",
    "tolerance_m": "toleranceM",
    "bounds_half_extent_m": "boundsHalfExtentM",
    "goal_min_distance_m": "goalMinDistanceM",
    "goal_max_distance_m": "goalMaxDistanceM",
    "max_start_slope": "maxStartSlope",
    "max_goal_slope": "maxGoalSlope",
    "sensor_noise_sigma_m": "sensorNoiseSigmaM",
    "traction_multiplier": "tractionMultiplier",
    "reward_weights": "rewardWeights",
    "rover": "rover",
    "terrain_subdivisions": "terrainSubdivisions",
}


class ArkEnv(gym.Env[np.ndarray, np.ndarray]):
    """Rover navigation on real ARK physics: drive to the goal before time runs out."""

    metadata: dict[str, Any] = {"render_modes": []}

    def __init__(
        self,
        planet: str = "mars",
        seed: int | None = None,
        terrain_seed: int | None = None,
        bridge_path: str | Path | None = None,
        runner: str | None = None,
        timeout: float = 120.0,
        **env_config: Any,
    ) -> None:
        """Create the env and boot its bridge process.

        Args:
            planet: "earth" or "mars" (validated server-side).
            seed: Convenience alias for terrain_seed (the fixed world seed).
            terrain_seed: Procedural terrain seed, fixed for the env's lifetime.
            bridge_path / runner / timeout: BridgeClient overrides.
            **env_config: snake_case create knobs (max_steps, action_repeat,
                tolerance_m, ...) translated to the bridge payload; unknown
                keys pass through as-is.
        """
        super().__init__()
        resolved_terrain_seed = terrain_seed if terrain_seed is not None else seed
        if resolved_terrain_seed is None:
            resolved_terrain_seed = self.np_random.integers(0, 2**31 - 1).item()
        payload: dict[str, Any] = {"planet": planet, "terrainSeed": resolved_terrain_seed}
        for key, value in env_config.items():
            payload[_CONFIG_KEYS.get(key, key)] = value

        self._client = BridgeClient(bridge_path=bridge_path, runner=runner, timeout=timeout)
        try:
            self._env_id = self._client.create(payload)
            spaces_desc = self._client.get_spaces()
        except Exception:
            self._client.close()
            raise
        self._terrain_seed = resolved_terrain_seed
        obs_desc = spaces_desc["observation"]
        act_desc = spaces_desc["action"]
        self.observation_space = spaces.Box(
            low=np.asarray(obs_desc["low"], dtype=np.float32),
            high=np.asarray(obs_desc["high"], dtype=np.float32),
            shape=tuple(obs_desc["shape"]),
            dtype=np.float32,
        )
        self.action_space = spaces.Box(
            low=np.asarray(act_desc["low"], dtype=np.float32),
            high=np.asarray(act_desc["high"], dtype=np.float32),
            shape=tuple(act_desc["shape"]),
            dtype=np.float32,
        )
        self._closed = False

    # -- gymnasium API --------------------------------------------------------

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        self._require_open()
        if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool)):
            raise ArkValidationError(f"reset seed must be an int, got {seed!r}.")
        result = self._client.reset(self._env_id, seed=seed, options=options)
        return self._checked_observation(result["observation"]), dict(result["info"])

    def step(
        self, action: np.ndarray | list[float] | tuple[float, ...]
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        self._require_open()
        try:
            vector = np.asarray(action, dtype=np.float32).reshape(-1)
        except (ValueError, TypeError) as exc:
            raise ArkValidationError(f"Action must be a 2-vector, got {action!r}.") from exc
        if vector.shape != (2,):
            raise ArkValidationError(f"Action must have shape (2,), got {vector.shape}.")
        if not np.all(np.isfinite(vector)):
            raise ArkValidationError(f"Action must be finite, got {vector!r}.")
        # Finite out-of-range values pass through: TypeScript clips them (Box
        # convention) and reports info["actionClipped"] — single source of truth.
        result = self._client.step(self._env_id, [float(vector[0]), float(vector[1])])
        return (
            self._checked_observation(result["observation"]),
            float(result["reward"]),
            bool(result["terminated"]),
            bool(result["truncated"]),
            dict(result["info"]),
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._client.close_env(self._env_id)
        except Exception:
            pass
        self._client.close()

    # -- helpers ---------------------------------------------------------------

    def get_metrics(self) -> dict[str, Any]:
        """Current episode metrics (zeros before the first step)."""
        self._require_open()
        return dict(self._client.get_metrics(self._env_id))

    @property
    def terrain_seed(self) -> int:
        return self._terrain_seed

    def _require_open(self) -> None:
        if self._closed:
            raise ArkProtocolError("ArkEnv is closed.")

    def _checked_observation(self, raw: Any) -> np.ndarray:
        """Fresh float32 array, validated against the declared space.

        Bound violations raise instead of clipping: the bridge guarantees
        normalized observations, so a violation means the contract changed.
        """
        obs = np.array(raw, dtype=np.float32, copy=True)
        expected = self.observation_space.shape
        if obs.shape != expected:
            raise ArkProtocolError(f"Observation shape {obs.shape} != declared {expected}.")
        if not np.all(np.isfinite(obs)):
            raise ArkProtocolError(f"Observation has non-finite values: {obs!r}.")
        low = self.observation_space.low
        high = self.observation_space.high
        if np.any(obs < low - _BOUNDS_EPS) or np.any(obs > high + _BOUNDS_EPS):
            raise ArkProtocolError(f"Observation outside declared bounds: {obs!r}.")
        return obs
