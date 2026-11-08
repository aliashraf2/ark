"""Tests C/E/I: canonical protocol validation — constraints, integrity, planets."""

from __future__ import annotations

import pytest

from world_commands import CommandValidationError, load_protocol, validate_command


def test_protocol_loads_canonical_version():
    protocol = load_protocol()
    assert protocol.raw["protocol"] == "ark.world-commands"
    assert protocol.raw["version"] == "4.0.0"
    assert len(protocol.commands) == 15


def test_unknown_command_rejected():
    with pytest.raises(CommandValidationError, match="Unknown command"):
        validate_command("launch_rockets", {}, "earth")


def test_unknown_param_rejected_state_integrity():
    # Extra keys are rejected, never silently carried into simulator state.
    with pytest.raises(CommandValidationError, match='Unknown param "density"'):
        validate_command("set_wind", {"speed_mps": 5, "direction_from_deg": 0, "density": 9}, "earth")


def test_wrong_planet_command_rejected():
    with pytest.raises(CommandValidationError, match='Event type "rain" cannot run on mars'):
        validate_command("start_weather_event", {"type": "rain", "targets": {"precipitation": 5}}, "mars")


def test_mars_dust_storm_allowed_and_rain_forbidden():
    ok = validate_command(
        "start_weather_event",
        {"type": "dust-storm", "targets": {"dustTau": 2.5}, "hold": 60},
        "mars",
    )
    assert ok.params["type"] == "dust-storm"
    with pytest.raises(CommandValidationError, match="cannot run on mars"):
        validate_command("start_weather_event", {"type": "cloud", "targets": {"cloudOpacity": 0.5}}, "mars")


def test_out_of_range_rejected_not_clamped():
    with pytest.raises(CommandValidationError, match="must be <="):
        validate_command("set_wind", {"speed_mps": 61, "direction_from_deg": 0}, "earth")
    with pytest.raises(CommandValidationError, match="must be >="):
        validate_command("set_temperature", {"celsius": -300}, "earth")


def test_non_finite_rejected():
    with pytest.raises(CommandValidationError, match="finite"):
        validate_command("set_gravity", {"magnitude_mps2": float("inf")}, "earth")
    with pytest.raises(CommandValidationError, match="finite"):
        validate_command("set_wind", {"speed_mps": float("nan"), "direction_from_deg": 0}, "earth")


def test_gravity_override_labeled_and_extreme_confirms():
    mild = validate_command("set_gravity", {"magnitude_mps2": 12}, "earth")
    assert mild.experimental_override is True
    assert any("experimental override" in warning for warning in mild.warnings)
    assert mild.requires_confirmation is False
    extreme = validate_command("set_gravity", {"magnitude_mps2": 25}, "earth")
    assert extreme.requires_confirmation is True
    nominal = validate_command("set_gravity", {"magnitude_mps2": 9.80665}, "earth")
    assert nominal.experimental_override is False


def test_planet_temperature_bounds_resolve():
    earth = validate_command("set_temperature", {"celsius": 20}, "earth")
    assert earth.params["celsius"] == 20.0
    with pytest.raises(CommandValidationError, match="must be"):
        validate_command("set_temperature", {"celsius": 30}, "mars")  # Mars max is 300K = 26.85C


def test_wind_vector_magnitude_bounded():
    with pytest.raises(CommandValidationError, match="magnitude must be"):
        validate_command(
            "start_weather_event",
            {"type": "wind", "targets": {"wind": {"x": 100, "y": 0, "z": 0}}},
            "earth",
        )


def test_missing_required_param():
    with pytest.raises(CommandValidationError, match='Missing required param "speed_mps"'):
        validate_command("set_wind", {"direction_from_deg": 0}, "earth")


def test_numeric_strings_coerce_to_numbers():
    """LLM planners quote numbers as strings; strict bounds still apply."""
    ok = validate_command(
        "set_wind", {"speed_mps": "20", "direction_from_deg": "270"}, "earth"
    )
    assert ok.params == {"speed_mps": 20.0, "direction_from_deg": 270.0}
    seed = validate_command("regenerate_terrain", {"seed": "42"}, "earth")
    assert seed.params == {"seed": 42}


def test_non_numeric_strings_still_rejected():
    with pytest.raises(CommandValidationError, match="must be a finite number"):
        validate_command("set_wind", {"speed_mps": "fast", "direction_from_deg": 0}, "earth")
    with pytest.raises(CommandValidationError, match="must be <="):
        validate_command("set_wind", {"speed_mps": "999", "direction_from_deg": 0}, "earth")
    with pytest.raises(CommandValidationError, match="must be a finite number"):
        validate_command("set_wind", {"speed_mps": True, "direction_from_deg": 0}, "earth")
