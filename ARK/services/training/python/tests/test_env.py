"""Gymnasium API compliance + behavior tests for ArkEnv (real physics)."""

import numpy as np
import pytest
from gymnasium import spaces

from ark_gym import ArkEnv
from ark_gym.exceptions import ArkEpisodeError, ArkProtocolError, ArkValidationError


def test_spaces_come_from_bridge_contract(env):
    assert isinstance(env.observation_space, spaces.Box)
    assert isinstance(env.action_space, spaces.Box)
    assert env.observation_space.shape == (12,)
    assert env.observation_space.dtype == np.float32
    assert env.action_space.shape == (2,)
    assert env.action_space.dtype == np.float32
    np.testing.assert_array_equal(
        env.observation_space.low,
        np.array([0, -1, -1, 0, -1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32),
    )
    np.testing.assert_array_equal(
        env.observation_space.high, np.ones(12, dtype=np.float32)
    )
    np.testing.assert_array_equal(
        env.action_space.low, np.array([-1, -1], dtype=np.float32)
    )
    np.testing.assert_array_equal(
        env.action_space.high, np.array([1, 1], dtype=np.float32)
    )


def test_reset_returns_observation_and_info(env):
    obs, info = env.reset(seed=42)
    assert isinstance(obs, np.ndarray) and obs.dtype == np.float32
    assert obs.shape == (12,)
    assert np.all(np.isfinite(obs))
    assert info["scenario"]["scenarioId"] == "mars:t7:e42:train"
    assert info["episodeIndex"] >= 0


def test_step_returns_gymnasium_five_tuple(env):
    env.reset(seed=1)
    obs, reward, terminated, truncated, info = env.step(np.array([0.5, 0.5], dtype=np.float32))
    assert isinstance(obs, np.ndarray) and obs.shape == (12,)
    assert isinstance(reward, float) and np.isfinite(reward)
    assert isinstance(terminated, bool) and isinstance(truncated, bool)
    assert isinstance(info, dict)
    assert info["metrics"]["length"] == 1
    assert "rewardTerms" in info and "actionClipped" in info


def test_deterministic_reset(env):
    obs_a, info_a = env.reset(seed=123)
    obs_b, info_b = env.reset(seed=123)
    np.testing.assert_array_equal(obs_a, obs_b)
    assert info_a["scenario"] == info_b["scenario"]
    obs_c, _ = env.reset(seed=124)
    assert not np.array_equal(obs_a, obs_c)


def test_reset_seed_validation(env):
    import gymnasium as gym

    # Non-int seeds are rejected by gymnasium's own seeding check (via super()).
    with pytest.raises(gym.error.Error):
        env.reset(seed=1.5)  # type: ignore[arg-type]
    with pytest.raises(gym.error.Error):
        env.reset(seed="42")  # type: ignore[arg-type]
    # bool is an int subclass: rejected explicitly so True never seeds as 1.
    with pytest.raises(ArkValidationError):
        env.reset(seed=True)  # type: ignore[arg-type]


def test_malformed_actions_rejected(env):
    env.reset(seed=2)
    with pytest.raises(ArkValidationError):
        env.step(np.array([0.5, 0.5, 0.5], dtype=np.float32))
    with pytest.raises(ArkValidationError):
        env.step(np.array([np.nan, 0.0], dtype=np.float32))
    with pytest.raises(ArkValidationError):
        env.step(np.array([0.0, np.inf], dtype=np.float32))
    with pytest.raises(ArkValidationError):
        env.step("forward")  # type: ignore[arg-type]


def test_finite_out_of_range_action_clipped_by_server(env):
    env.reset(seed=3)
    _, _, _, _, info = env.step(np.array([2.0, -3.0], dtype=np.float32))
    assert info["actionClipped"] is True
    _, _, _, _, info = env.step(np.array([0.5, -0.5], dtype=np.float32))
    assert info["actionClipped"] is False


def test_step_after_done_requires_reset():
    env = ArkEnv(planet="earth", terrain_seed=9, terrain_subdivisions=16, max_steps=2)
    try:
        env.reset(seed=5)
        env.step(np.zeros(2, dtype=np.float32))
        _, _, _, truncated, _ = env.step(np.zeros(2, dtype=np.float32))
        assert truncated is True
        with pytest.raises(ArkEpisodeError):
            env.step(np.zeros(2, dtype=np.float32))
        obs, _ = env.reset(seed=6)  # reset recovers
        assert obs.shape == (12,)
    finally:
        env.close()


def test_close_is_idempotent_and_blocks_use():
    env = ArkEnv(planet="earth", terrain_seed=9, terrain_subdivisions=16)
    env.reset(seed=1)
    env.close()
    env.close()
    with pytest.raises(ArkProtocolError):
        env.reset(seed=1)


def test_observations_are_independent_arrays(env):
    obs_a, _ = env.reset(seed=50)
    snapshot = obs_a.copy()
    obs_a[:] = 999.0  # mutating the returned buffer must not corrupt the env
    obs_b, _ = env.reset(seed=50)
    assert obs_b is not obs_a
    np.testing.assert_array_equal(obs_b, snapshot)


def test_metrics_track_real_episode(env):
    env.reset(seed=60)
    metrics = env.get_metrics()
    assert metrics["length"] == 0
    total = 0.0
    for _ in range(5):
        _, reward, terminated, truncated, _ = env.step(np.ones(2, dtype=np.float32))
        total += reward
        if terminated or truncated:
            break
    metrics = env.get_metrics()
    assert metrics["length"] > 0
    assert metrics["episodeReward"] == pytest.approx(total)
    assert metrics["distanceTraveledM"] > 0  # real Rapier motion, not commanded effort
    assert metrics["energyJ"] > 0


def test_gymnasium_passive_checker():
    """gymnasium's own compliance checker: the SB3-compat proxy."""
    import gymnasium.utils.env_checker as checker

    env = ArkEnv(
        planet="earth",
        terrain_seed=11,
        terrain_subdivisions=16,
        max_steps=50,
        goal_min_distance_m=10,
        goal_max_distance_m=20,
    )
    try:
        checker.check_env(env, skip_render_check=True)
    finally:
        env.close()
