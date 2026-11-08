"""Shared fixtures: isolate agent data + planner dirs per test."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def agent_dirs(tmp_path, monkeypatch):
    data = tmp_path / "data"
    planner = tmp_path / "planner"
    monkeypatch.setenv("ARK_AGENT_DATA", str(data))
    monkeypatch.setenv("ARK_ENV_PATH", str(tmp_path / ".env"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    for name in ("MUSE_API_KEY", "MODEL_API_KEY", "MUSE_MODEL", "ARK_LLM_PROVIDER", "ARK_PUBLIC_ORIGIN", "ARK_PROXY_TOKEN", "ARK_CORS_ORIGINS"):
        monkeypatch.delenv(name, raising=False)
    return {"data": data, "planner": str(planner)}


@pytest.fixture()
def world_state():
    return {
        "planet": "earth",
        "planetDisplayName": "Earth",
        "simTime": 12.5,
        "status": "running",
        "gravity": {"x": 0, "y": -9.80665, "z": 0},
        "sphere": {"position": {"x": 0, "y": 3.1, "z": 0}, "velocityY": -4.2},
        "box": None,
        "environment": {
            "wind": {"x": 2, "y": 0, "z": 0},
            "precipitation": 0,
            "dustTau": 0,
            "temperature": 288.15,
            "solarMultiplier": 1,
            "activeEventIds": [],
        },
        "seed": 7,
        "profileId": "earth-rolling-hills",
    }
