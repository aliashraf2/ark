"""Capability synthesis: constrained to declarative compositions of existing
world commands. Synthesized code NEVER executes physics directly — it returns a
spec (JSON-serializable steps), and trusted ARK code validates every step
against the canonical protocol before the capability can be approved.

The generated Python runs once inside CSP's sandboxed subprocess (timeout +
isolated process) purely to produce the spec. Execution always flows through
the validated world-command dispatcher in the simulator.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from world_commands import CommandValidationError, load_protocol, validate_command

MAX_SYNTHESIS_STEPS = 8

SYNTHESIS_GUIDANCE = """\
You are synthesizing an ARK Mission Control capability. Hard constraints:

1. Your `run(args)` function MUST return a JSON-serializable dict with exactly:
   {"description": str, "steps": [{"command": str, "params": dict}, ...]}
   where every "command" is one of the already-registered ARK world commands
   (set_wind, start_weather_event, set_temperature, set_surface_traction,
   set_solar_illumination, set_gravity, switch_planet, regenerate_terrain,
   pause_simulation, resume_simulation, reset_environment, apply_scenario,
   stop_weather_event, get_world_state, list_capabilities).
2. Use at most 8 steps. Every step's params must respect the registered
   command's schema (units, ranges, planets). No other function calls, no
   imports, no I/O, no invented physics, no invented commands.
3. "args" supplied at call time may parameterize step params (e.g. duration,
   intensity) but must never widen a step beyond its schema.
4. If the goal cannot be expressed as such a composition, return
   {"description": ..., "steps": []} and explain why in "description".

Anything outside this shape is rejected by the validator and the capability
is never registered.
"""


@dataclass
class SynthesisValidation:
    ok: bool
    errors: list[str] = field(default_factory=list)
    steps: list[dict[str, Any]] = field(default_factory=list)


def validate_synthesis_spec(spec: Any, planet: str) -> SynthesisValidation:
    """Validate a synthesized composition spec. Pure; trusted ARK code."""
    errors: list[str] = []
    if not isinstance(spec, dict):
        return SynthesisValidation(ok=False, errors=["Synthesis output must be an object."])
    steps = spec.get("steps")
    if not isinstance(steps, list):
        return SynthesisValidation(ok=False, errors=["Synthesis output needs a 'steps' list."])
    if len(steps) == 0:
        return SynthesisValidation(
            ok=False,
            errors=["Synthesis produced no executable steps: " + str(spec.get("description", ""))],
        )
    if len(steps) > MAX_SYNTHESIS_STEPS:
        return SynthesisValidation(
            ok=False, errors=[f"Too many steps ({len(steps)} > {MAX_SYNTHESIS_STEPS})."]
        )
    validated: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            errors.append(f"Step {index} is not an object.")
            continue
        command = step.get("command")
        params = step.get("params", {})
        if not isinstance(command, str):
            errors.append(f"Step {index} is missing a command name.")
            continue
        try:
            normalized = validate_command(command, params, planet)
        except CommandValidationError as exc:
            errors.append(f"Step {index} ({command}): {exc}")
            continue
        validated.append({"command": normalized.command, "params": normalized.params})
    if errors:
        return SynthesisValidation(ok=False, errors=errors)
    return SynthesisValidation(ok=True, steps=validated)


def data_dir() -> Path:
    override = os.environ.get("ARK_AGENT_DATA")
    if override:
        path = Path(override)
    else:
        path = Path(__file__).resolve().parent / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def approved_path() -> Path:
    return data_dir() / "approved_capabilities.json"


def load_approved() -> dict[str, Any]:
    path = approved_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def save_approved(name: str, entry: dict[str, Any]) -> None:
    approved = load_approved()
    approved[name] = entry
    approved_path().write_text(json.dumps(approved, indent=2))
