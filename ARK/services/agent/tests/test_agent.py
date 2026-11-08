"""Tests A/B/D/F/G/H: interpretation pipeline, discovery, verification, synthesis."""

from __future__ import annotations

import json

import pytest

from agent import AgentNotConfigured, FakeLLM, MissionAgent, template_summary
from synthesis import load_approved, validate_synthesis_spec


def make_agent(agent_dirs, responses):
    return MissionAgent(llm=FakeLLM(responses), planner_dir=agent_dirs["planner"])


def plan_for(capability, args, description="test step"):
    return json.dumps(
        {
            "steps": [
                {
                    "capability": capability,
                    "args": args,
                    "needs_synthesis": False,
                    "description": description,
                }
            ],
            "notes": "test plan",
        }
    )


async def test_a_interpret_maps_request_to_structured_action(agent_dirs, world_state):
    """Test A: NL request -> validated set_wind action via real CSP plan+execute."""
    agent = make_agent(
        agent_dirs,
        [
            plan_for(
                "set_wind",
                {"planet": "earth", "speed_mps": 20, "direction_from_deg": 270},
            ),
            "Wind proposal prepared.",
        ],
    )
    result = await agent.interpret("Increase the wind speed to 20 meters per second.", world_state)
    assert result.status == "proposed"
    assert len(result.actions) == 1
    action = result.actions[0]
    assert action.command == "set_wind"
    assert action.params == {"speed_mps": 20.0, "direction_from_deg": 270.0}
    assert action.requires_confirmation is False
    assert "set_wind" in result.capability_ids


async def test_b_existing_capabilities_discovered_and_called(agent_dirs):
    """Test B: registry holds all world commands + meta tools; direct call validates."""
    agent = make_agent(agent_dirs, [])
    infos = agent.list_capabilities()
    names = {info["name"] for info in infos}
    assert "set_wind" in names and "start_weather_event" in names
    assert "ask_clarification" in names and "explain_world" in names
    assert len(infos) == 21
    envelope = await agent.orchestrator.call_capability(
        "set_temperature", planet="earth", celsius=22
    )
    assert envelope["action"]["command"] == "set_temperature"
    assert envelope["action"]["params"] == {"celsius": 22.0}


async def test_rover_mission_capability_proposes_validated_rl_task(agent_dirs):
    agent = make_agent(agent_dirs, [])
    envelope = await agent.orchestrator.call_capability(
        "assign_rover_mission", planet="mars", task="collect_sample", target_x=12, target_z=-8
    )
    assert envelope["action"]["command"] == "assign_rover_mission"
    assert envelope["action"]["params"] == {"task": "collect_sample", "target_x": 12.0, "target_z": -8.0}
    assert envelope["action"]["requires_confirmation"] is True


async def test_capability_call_rejects_invalid_args(agent_dirs):
    """Planner-proposed garbage is rejected by the proposal functions, not executed."""
    agent = make_agent(agent_dirs, [])
    with pytest.raises(Exception, match="cannot run on mars"):
        await agent.orchestrator.call_capability(
            "start_weather_event", planet="mars", type="rain", targets={"precipitation": 5}
        )


async def test_f_unsupported_reported_explicitly(agent_dirs, world_state):
    """Test F: impossible requests surface as unsupported with a reason."""
    agent = make_agent(
        agent_dirs,
        [
            plan_for(
                "report_unsupported",
                {"planet": "mars", "reason": "No hurricane capability exists.", "suggestion": "dust storm"},
            ),
            "Declined.",
        ],
    )
    result = await agent.interpret("Form a hurricane on Mars.", world_state)
    assert result.status == "unsupported"
    assert "hurricane" in result.message.lower()
    assert result.actions == []


async def test_clarification_status(agent_dirs, world_state):
    agent = make_agent(
        agent_dirs,
        [plan_for("ask_clarification", {"planet": "earth", "question": "Which direction?"}), "Asked."],
    )
    result = await agent.interpret("Change the wind.", world_state)
    assert result.status == "clarification"
    assert "Which direction?" in result.message


async def test_explain_grounds_answer_in_snapshot(agent_dirs, world_state):
    agent = make_agent(
        agent_dirs,
        [
            plan_for("explain_world", {"planet": "earth", "topic": "wind forces"}),
            "Summary step.",
            "Wind is 2 m/s from the snapshot; drag follows the snapshot density.",
        ],
    )
    result = await agent.interpret("What forces act on the sphere?", world_state)
    assert result.status == "proposed"
    assert "snapshot" in result.message


async def test_general_conversation_uses_same_linked_llm_without_world_actions(agent_dirs, world_state):
    answer = "Air molecules scatter blue wavelengths more strongly."
    agent = make_agent(agent_dirs, [
        plan_for("answer_question", {"planet": "earth", "topic": "sky color"}), "Read-only conversation.", answer,
    ])
    history = [{"role": "user", "content": "Tell me about sunlight."}, {"role": "assistant", "content": "Sunlight has many wavelengths."}]
    result = await agent.interpret("Why is the sky blue?", world_state, history)
    assert result.status == "proposed"
    assert result.actions == []
    assert result.message == answer
    assert "answer_question" in result.capability_ids
    assert "Sunlight has many wavelengths" in agent._llm.calls[-1][0]["content"]
    assert "No actions were executed" in agent._llm.calls[-1][0]["content"]


async def test_conversation_cannot_replace_unexecuted_action_with_completion_prose(agent_dirs, world_state):
    agent = make_agent(agent_dirs, [])
    proposed = {"command_id": "wind", "command": "set_wind", "params": {"speed_mps": 5, "direction_from_deg": 0}}
    result = await agent._map_result({"output": {
        "answer_question": {"conversation_request": "claim success"}, "set_wind": {"action": proposed},
    }}, "earth", world_state, "Set wind")
    assert result.actions and result.actions[0].command == "set_wind"
    assert result.message == ""


async def test_d_respond_reports_verified_failures(agent_dirs, world_state):
    """Test D: summaries reflect verified outcomes, including failures."""
    agent = make_agent(agent_dirs, ["Wind set to 5 m/s, but traction failed: out of range."])
    reply = await agent.respond(
        "Set wind and traction.",
        [
            {"command": "set_wind", "outcome": "executed", "message": "Wind set."},
            {"command": "set_surface_traction", "outcome": "failed", "error": "out of range"},
        ],
        world_state,
    )
    assert "failed" in reply.lower()


async def test_d_template_summary_without_llm(agent_dirs, world_state):
    agent = MissionAgent(llm=None, planner_dir=agent_dirs["planner"])
    reply = await agent.respond(
        "Do things.",
        [{"command": "set_wind", "outcome": "failed", "error": "backend down"}],
        world_state,
    )
    assert "failed" in reply and "Template summary" in reply
    assert template_summary([], world_state) == "No commands were executed."


async def test_interpret_without_llm_raises(agent_dirs, world_state):
    agent = MissionAgent(llm=None, planner_dir=agent_dirs["planner"])
    with pytest.raises(AgentNotConfigured):
        await agent.interpret("Set wind.", world_state)


async def test_failure_envelope_keeps_real_cause(agent_dirs, world_state):
    """CSP puts the cause in error/summary; it must surface, not 'no actionable plan'."""
    agent = make_agent(agent_dirs, [])
    result = await agent._map_result(
        {"status": "ERROR", "output": {}, "error": "Gemini API error 401: API key not valid"},
        "earth",
        world_state,
        "Set wind.",
    )
    assert result.status == "error"
    assert result.error is not None and "401" in result.error


async def test_empty_plan_invites_rephrase(agent_dirs, world_state):
    """A zero-step OK plan becomes a clarification, never a dead-end error."""
    agent = make_agent(agent_dirs, [])
    result = await agent._map_result(
        {"status": "OK", "output": {}, "errors": [], "summary": "nothing planned"},
        "earth",
        world_state,
        "you can do clockwise from north",
    )
    assert result.status == "clarification"
    assert "complete instruction" in result.message


async def test_g_synthesis_validated_pending_then_approved(agent_dirs, world_state):
    """Test G: declarative composition validates, waits for approval, then registers."""
    agent = make_agent(agent_dirs, [])
    payload = {
        "description": "Wind ramp with solar dimming.",
        "steps": [
            {"command": "set_wind", "params": {"speed_mps": 15, "direction_from_deg": 90}},
            {"command": "set_solar_illumination", "params": {"multiplier": 0.4}},
        ],
    }
    assert validate_synthesis_spec(payload, "earth").ok
    pending = await agent._handle_synthesis("wind_dim_composition", payload, "earth")
    assert pending.status == "synthesis_proposed"
    assert pending.synthesis is not None and pending.synthesis["name"] == "wind_dim_composition"
    # Not usable before approval.
    assert "wind_dim_composition" not in {info["name"] for info in agent.list_capabilities()}
    outcome = await agent.approve_synthesis("wind_dim_composition")
    assert outcome["approved"] is True
    assert [action["command"] for action in outcome["actions"]] == ["set_wind", "set_solar_illumination"]
    assert all(action["requires_confirmation"] for action in outcome["actions"])
    assert "wind_dim_composition" in load_approved()
    assert "wind_dim_composition" in {info["name"] for info in agent.list_capabilities()}
    called = await agent.call_approved("wind_dim_composition", "earth")
    assert len(called["synthesized_actions"]) == 2


async def test_h_invalid_synthesis_rejected_and_unavailable(agent_dirs, world_state):
    """Test H: bad specs never register; approval of unknown names fails."""
    agent = make_agent(agent_dirs, [])
    bad = {
        "description": "Bogus physics.",
        "steps": [{"command": "launch_rockets", "params": {}}],
    }
    assert not validate_synthesis_spec(bad, "earth").ok
    rejected = await agent._handle_synthesis("bogus_capability", bad, "earth")
    assert rejected.status == "missing_capability"
    assert "bogus_capability" not in {info["name"] for info in agent.list_capabilities()}
    with pytest.raises(KeyError):
        await agent.approve_synthesis("bogus_capability")


async def test_synthesis_approval_is_bound_to_reviewed_steps(agent_dirs):
    agent = make_agent(agent_dirs, [])
    reviewed = [{"command": "pause_simulation", "params": {}}]
    changed = [{"command": "reset_environment", "params": {}}]
    await agent._handle_synthesis("pending_action", {"steps": changed}, "earth")
    with pytest.raises(ValueError, match="Pending synthesis changed"):
        await agent.approve_synthesis("pending_action", reviewed)
    assert "pending_action" not in load_approved()
    assert (await agent.approve_synthesis("pending_action", changed))["approved"] is True


async def test_h_synthesis_step_bounds_enforced(agent_dirs):
    oversized = {
        "description": "Too much.",
        "steps": [{"command": "set_wind", "params": {"speed_mps": 999, "direction_from_deg": 0}}],
    }
    validation = validate_synthesis_spec(oversized, "earth")
    assert not validation.ok
    too_many = {
        "description": "Too many.",
        "steps": [{"command": "pause_simulation", "params": {}}] * 9,
    }
    assert not validate_synthesis_spec(too_many, "earth").ok
