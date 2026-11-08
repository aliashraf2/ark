"""Bridge protocol tests through BridgeClient (real server process)."""

import pytest

from ark_gym.client import PROTOCOL_VERSION
from ark_gym.exceptions import (
    ArkEpisodeError,
    ArkProtocolError,
    ArkUnknownEnvError,
    ArkValidationError,
    ArkEnvLimitError,
)

TINY = {"planet": "mars", "terrainSeed": 3, "terrainSubdivisions": 8}


def test_hello_reports_protocol_version(client):
    assert client.hello()["protocolVersion"] == PROTOCOL_VERSION


def test_unknown_command_is_explicit_error(client):
    with pytest.raises(ArkProtocolError, match="unknown_command|Unknown command"):
        client._request("teleport")


def test_create_reset_step_roundtrip(client):
    env_id = client.create(dict(TINY))
    try:
        reset = client.reset(env_id, seed=7)
        assert len(reset["observation"]) == 12
        assert reset["info"]["scenario"]["scenarioId"] == "mars:t3:e7:train"
        step = client.step(env_id, [0.5, -0.5])
        assert set(step) >= {"observation", "reward", "terminated", "truncated", "info"}
        assert len(step["observation"]) == 12
        assert isinstance(step["reward"], float)
    finally:
        client.close_env(env_id)


def test_drone_bridge_uses_three_action_channels(client):
    env_id = client.create({**TINY, "agentType": "drone"})
    try:
        spaces = client.get_spaces("drone")
        assert spaces["observation"]["shape"] == [9]
        assert spaces["action"]["shape"] == [3]
        reset = client.reset(env_id, seed=11)
        assert len(reset["observation"]) == 9
        step = client.step(env_id, [0.0, 0.0, 0.0])
        assert len(step["observation"]) == 9
        assert step["info"]["metrics"]["length"] == 1
    finally:
        client.close_env(env_id)


def test_unknown_env_ids_rejected(client):
    with pytest.raises(ArkUnknownEnvError):
        client.reset("env-nope", seed=1)
    with pytest.raises(ArkUnknownEnvError):
        client.step("env-nope", [0.0, 0.0])
    with pytest.raises(ArkUnknownEnvError):
        client.get_metrics("env-nope")
    with pytest.raises(ArkUnknownEnvError):
        client.close_env("env-nope")


def test_step_before_reset_rejected(client):
    env_id = client.create(dict(TINY))
    try:
        with pytest.raises(ArkEpisodeError):
            client.step(env_id, [0.0, 0.0])
        with pytest.raises(ArkEpisodeError):
            client.get_metrics(env_id)
    finally:
        client.close_env(env_id)


def test_closed_env_rejected_after_close(client):
    env_id = client.create(dict(TINY))
    client.reset(env_id, seed=1)
    client.close_env(env_id)
    with pytest.raises(ArkUnknownEnvError):
        client.step(env_id, [0.0, 0.0])


def test_malformed_actions_rejected_without_touching_sim(client):
    env_id = client.create(dict(TINY))
    try:
        client.reset(env_id, seed=1)
        with pytest.raises(ArkValidationError):
            client.step(env_id, [0.5])
        with pytest.raises(ArkValidationError):
            client.step(env_id, ["x", 0.0])
        with pytest.raises(ArkValidationError):
            client.step(env_id, "forward")
        # Validation failures consume no steps.
        assert client.get_metrics(env_id)["length"] == 0
    finally:
        client.close_env(env_id)


def test_invalid_create_config_rejected(client):
    with pytest.raises(ArkValidationError):
        client.create({"planet": "venus", "terrainSeed": 1})
    with pytest.raises(ArkValidationError):
        client.create({"planet": "mars", "terrainSeed": 1.5})


def test_two_envs_in_one_bridge_are_independent(client):
    env_a = client.create(dict(TINY))
    env_b = client.create({"planet": "earth", "terrainSeed": 4, "terrainSubdivisions": 8})
    try:
        client.reset(env_a, seed=5)
        client.reset(env_b, seed=5)
        for _ in range(3):
            client.step(env_a, [1.0, 1.0])
        assert client.get_metrics(env_a)["length"] == 3
        assert client.get_metrics(env_b)["length"] == 0
    finally:
        client.close_env(env_a)
        client.close_env(env_b)


def test_live_env_limit_enforced(client):
    created = []
    try:
        for i in range(8):
            created.append(client.create(dict(TINY, terrainSeed=100 + i)))
        with pytest.raises(ArkEnvLimitError):
            client.create(dict(TINY))
    finally:
        for env_id in created:
            client.close_env(env_id)


def test_server_survives_error_burst(client):
    env_id = client.create(dict(TINY))
    try:
        for _ in range(10):
            with pytest.raises(ArkValidationError):
                client.step(env_id, ["x", 0.0])  # reaches the server, rejected there
        with pytest.raises(ArkValidationError):
            client.step(env_id, [float("nan"), 0.0])  # rejected client-side, never sent
        client.reset(env_id, seed=9)
        step = client.step(env_id, [0.1, 0.1])
        assert len(step["observation"]) == 12
    finally:
        client.close_env(env_id)
