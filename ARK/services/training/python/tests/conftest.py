"""Shared fixtures: one bridge process per test module."""

import pytest

from ark_gym import ArkEnv, BridgeClient


@pytest.fixture(scope="module")
def client():
    with BridgeClient() as bridge:
        yield bridge


@pytest.fixture(scope="module")
def env():
    # Small terrain grid keeps tests fast; physics is identical in kind.
    instance = ArkEnv(planet="mars", terrain_seed=7, terrain_subdivisions=32)
    yield instance
    instance.close()
