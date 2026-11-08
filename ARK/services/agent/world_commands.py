"""Canonical world-command protocol: loads packages/shared/world-commands.json
(the single source of truth) and validates proposed commands against it.

Mirrors the TypeScript normalizeCommand semantics exactly: strict rejection of
unknown commands/params, type checks, range checks with planet-resolved bounds,
event type-planet gating, and gravity-override labeling.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class CommandValidationError(ValueError):
    """A proposed command violates the canonical protocol."""


def _protocol_path() -> Path:
    override = os.environ.get("ARK_PROTOCOL_PATH")
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        candidate = parent / "packages" / "shared" / "world-commands.json"
        if candidate.exists():
            return candidate
    raise FileNotFoundError("world-commands.json not found; set ARK_PROTOCOL_PATH.")


@dataclass(frozen=True)
class Protocol:
    raw: dict[str, Any]

    @property
    def commands(self) -> dict[str, Any]:
        return self.raw["commands"]

    @property
    def planets(self) -> dict[str, Any]:
        return self.raw["planets"]

    @property
    def event_targets(self) -> dict[str, Any]:
        return self.raw["eventTargets"]

    @property
    def event_type_planets(self) -> dict[str, list[str]]:
        return self.raw["eventTypePlanets"]


_protocol: Protocol | None = None


def load_protocol() -> Protocol:
    global _protocol
    if _protocol is None:
        _protocol = Protocol(json.loads(_protocol_path().read_text()))
    return _protocol


@dataclass
class NormalizedCommand:
    command: str
    params: dict[str, Any]
    planet: str
    requires_confirmation: bool
    reversible: bool
    warnings: list[str] = field(default_factory=list)
    experimental_override: bool = False


def _coerce_finite(value: Any) -> float | None:
    """Coerce ints, floats, and numeric strings to a finite float.

    LLM planners routinely quote numbers as JSON strings; accepting "20" as
    20.0 is safe normalization. Bounds, finiteness, and integer checks still
    apply downstream — nothing is clamped, only parsed. Bools never coerce.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _planet_bounds(protocol: Protocol, planet: str, celsius: bool) -> tuple[float, float]:
    entry = protocol.planets.get(planet)
    if entry is None:
        raise CommandValidationError(f"Unknown planet {planet!r}.")
    lo = float(entry["temperatureMinK"])
    hi = float(entry["temperatureMaxK"])
    if celsius:
        lo -= 273.15
        hi -= 273.15
    return lo, hi


def validate_command(command: str, params: Any, planet: str) -> NormalizedCommand:
    """Validate + normalize one proposed command. Raises CommandValidationError."""
    protocol = load_protocol()
    descriptor = protocol.commands.get(command)
    if descriptor is None:
        raise CommandValidationError(f"Unknown command {command!r}.")
    if planet not in descriptor.get("planets", []):
        raise CommandValidationError(f'Command "{command}" is not supported on {planet}.')
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise CommandValidationError(f'Params for "{command}" must be an object.')

    normalized: dict[str, Any] = {}
    schemas: dict[str, Any] = descriptor.get("params", {})
    for name, schema in schemas.items():
        value = params.get(name)
        if value is None:
            if schema.get("required"):
                raise CommandValidationError(f'Missing required param "{name}" for "{command}".')
            if "default" in schema:
                normalized[name] = schema["default"]
            continue
        normalized[name] = _validate_param(protocol, command, name, schema, value, planet)
    for name in params:
        if name not in schemas:
            raise CommandValidationError(f'Unknown param "{name}" for "{command}".')

    requires_confirmation = bool(descriptor.get("requiresConfirmation", False))
    warnings: list[str] = []
    experimental = False
    if command == "set_gravity":
        magnitude = float(normalized["magnitude_mps2"])
        planetary = float(protocol.planets[planet]["gravity"])
        ratio = magnitude / planetary
        if magnitude != planetary:
            experimental = True
            warnings.append(
                f"Gravity {magnitude} m/s^2 differs from the {planet} default "
                f"({planetary} m/s^2): experimental override, not realistic planetary physics."
            )
        if ratio > 2 or ratio < 0.5:
            requires_confirmation = True
            warnings.append("Extreme gravity override: confirmation required.")
    if command == "start_weather_event":
        event_type = str(normalized["type"])
        allowed = protocol.event_type_planets.get(event_type, [])
        if planet not in allowed:
            raise CommandValidationError(f'Event type "{event_type}" cannot run on {planet}.')

    return NormalizedCommand(
        command=command,
        params=normalized,
        planet=planet,
        requires_confirmation=requires_confirmation,
        reversible=bool(descriptor.get("reversible", False)),
        warnings=warnings,
        experimental_override=experimental,
    )


def _validate_param(
    protocol: Protocol,
    command: str,
    name: str,
    schema: dict[str, Any],
    value: Any,
    planet: str,
) -> Any:
    label = f'"{name}" for "{command}"'
    kind = schema.get("type")
    if kind in ("number", "integer"):
        number = _coerce_finite(value)
        if number is None:
            raise CommandValidationError(f"{label} must be a finite number.")
        if kind == "integer" and not number.is_integer():
            raise CommandValidationError(f"{label} must be an integer.")
        lo, hi = _resolve_range(protocol, schema, planet)
        if lo is not None and number < lo:
            raise CommandValidationError(f"{label} must be >= {lo}.")
        if hi is not None and number > hi:
            raise CommandValidationError(f"{label} must be <= {hi}.")
        return int(number) if kind == "integer" else number
    if kind == "string":
        if not isinstance(value, str) or not value:
            raise CommandValidationError(f"{label} must be a non-empty string.")
        return value
    if kind == "enum":
        values = schema.get("values", [])
        if value not in values:
            raise CommandValidationError(f"{label} must be one of: {', '.join(values)}.")
        return value
    if kind == "vector3":
        return _validate_vector3(value, label)
    if kind == "event_targets":
        return _validate_targets(protocol, value, label, planet)
    raise CommandValidationError(f"{label} has unsupported schema type {kind!r}.")


def _resolve_range(
    protocol: Protocol, schema: dict[str, Any], planet: str
) -> tuple[float | None, float | None]:
    if schema.get("range") == "planet_temperature":
        lo, hi = _planet_bounds(protocol, planet, celsius=True)
        return lo, hi
    if schema.get("range") == "planet_temperature_kelvin":
        lo, hi = _planet_bounds(protocol, planet, celsius=False)
        return lo, hi
    lo = schema.get("min")
    hi = schema.get("max")
    return (float(lo) if lo is not None else None, float(hi) if hi is not None else None)


def _validate_vector3(value: Any, label: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise CommandValidationError(f"{label} must be an {{x, y, z}} object.")
    components = {}
    for axis in ("x", "y", "z"):
        component = _coerce_finite(value.get(axis))
        if component is None:
            raise CommandValidationError(f"{label}.{axis} must be a finite number.")
        components[axis] = component
    magnitude = math.sqrt(sum(c * c for c in components.values()))
    if magnitude > 60:
        raise CommandValidationError(f"{label} magnitude must be <= 60 m/s.")
    return components


def _validate_targets(protocol: Protocol, value: Any, label: str, planet: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not value:
        raise CommandValidationError(f"{label} must be an object with at least one target channel.")
    targets: dict[str, Any] = {}
    for channel, target in value.items():
        channel_label = f'target "{channel}"'
        entry = protocol.event_targets.get(channel)
        if entry is None:
            raise CommandValidationError(
                f"Unknown {channel_label}. Supported channels: "
                + ", ".join(sorted(protocol.event_targets))
                + "."
            )
        if entry.get("type") == "vector3":
            targets[channel] = _validate_vector3(target, channel_label)
            continue
        lo, hi = _target_range(protocol, entry, planet)
        unit = str(entry.get("unit", ""))
        targets[channel] = _bounded_number(target, channel_label, lo, hi, unit)
    return targets


def _bounded_number(value: Any, label: str, lo: float, hi: float, unit: str) -> float:
    number = _coerce_finite(value)
    if number is None:
        raise CommandValidationError(f"{label} must be a finite number.")
    suffix = f" {unit}" if unit else ""
    if number < lo or number > hi:
        raise CommandValidationError(f"{label} must be within {lo}..{hi}{suffix}.")
    return number


def _target_range(
    protocol: Protocol, entry: dict[str, Any], planet: str
) -> tuple[float, float]:
    """Bounds come from the canonical schema; planet ranges resolve per world."""
    if entry.get("range") == "planet_temperature_kelvin":
        return _planet_bounds(protocol, planet, celsius=False)
    lo = entry.get("min")
    hi = entry.get("max")
    if lo is None or hi is None:
        raise CommandValidationError("Canonical schema is missing target bounds.")
    return float(lo), float(hi)
