"""ARK Mission Control agent: CSP-orchestrated interpretation of natural
language into validated world commands.

Architecture: the LLM plans via CSP-registered capabilities, but every
registered capability is a PURE PROPOSAL function — it validates arguments
against the canonical protocol and returns a command envelope. Nothing here
touches physics. The browser simulator re-validates, executes through its
command dispatcher, and reports verified telemetry; only then does the agent
describe outcomes.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

from csp import BaseLLM, LLMResponse, Orchestrator

from llm import create_llm_from_env  # noqa: F401  (re-exported for app/tests)
from synthesis import (
    SYNTHESIS_GUIDANCE,
    load_approved,
    save_approved,
    validate_synthesis_spec,
)
from world_commands import CommandValidationError, load_protocol, validate_command


class AgentNotConfigured(Exception):
    """No LLM credentials available for interpretation."""


@dataclass
class ProposedAction:
    command_id: str
    command: str
    params: dict[str, Any]
    requires_confirmation: bool
    reversible: bool
    warnings: list[str]
    rationale: str


@dataclass
class InterpretResult:
    status: str  # proposed|clarification|unsupported|missing_capability|synthesis_proposed|error
    message: str
    actions: list[ProposedAction] = field(default_factory=list)
    capability_ids: list[str] = field(default_factory=list)
    missing_capability: dict[str, str] | None = None
    synthesis: dict[str, Any] | None = None
    error: str | None = None


REGISTERED_WORLD_COMMANDS = [
    "get_world_state",
    "list_capabilities",
    "switch_planet",
    "set_gravity",
    "set_wind",
    "set_temperature",
    "set_surface_traction",
    "start_weather_event",
    "stop_weather_event",
    "set_solar_illumination",
    "regenerate_terrain",
    "pause_simulation",
    "resume_simulation",
    "reset_environment",
    "apply_scenario",
]

META_CAPABILITIES = ["ask_clarification", "explain_world", "report_unsupported"]


def _propose(command: str, params: dict[str, Any], planet: str, rationale: str) -> dict[str, Any]:
    normalized = validate_command(command, params, planet)
    return {
        "action": {
            "command_id": uuid.uuid4().hex,
            "command": normalized.command,
            "params": normalized.params,
            "requires_confirmation": normalized.requires_confirmation,
            "reversible": normalized.reversible,
            "warnings": normalized.warnings,
            "rationale": rationale,
        }
    }


def register_world_capabilities(app: Orchestrator) -> None:
    """Register one pure-proposal capability per world command, plus meta
    capabilities for clarification, grounded explanation, and explicit refusal."""

    @app.capability(description="Read the current world snapshot (planet, sim time, environment, test bodies). Use before answering questions about current conditions.")
    async def get_world_state(planet: str) -> dict[str, Any]:
        return _propose("get_world_state", {}, planet, "Read current world state.")

    @app.capability(description="List all registered world capabilities with their schemas.")
    async def list_capabilities(planet: str) -> dict[str, Any]:
        return _propose("list_capabilities", {}, planet, "List capabilities.")

    @app.capability(description="Switch the active world between Earth and Mars. Requires user confirmation.")
    async def switch_planet(planet: str, target_planet: str) -> dict[str, Any]:
        return _propose("switch_planet", {"planet": target_planet}, planet, f"Switch to {target_planet}.")

    @app.capability(
        description="Set gravity magnitude in m/s^2 (0.1..30). Values far from the planetary default are experimental overrides, NOT realistic physics — say so."
    )
    async def set_gravity(planet: str, magnitude_mps2: float) -> dict[str, Any]:
        return _propose("set_gravity", {"magnitude_mps2": magnitude_mps2}, planet, "Gravity experiment.")

    @app.capability(description="Set wind by speed in m/s (0..60) and compass direction FROM which it blows (degrees clockwise from north).")
    async def set_wind(planet: str, speed_mps: float, direction_from_deg: float) -> dict[str, Any]:
        return _propose(
            "set_wind",
            {"speed_mps": speed_mps, "direction_from_deg": direction_from_deg},
            planet,
            "Adjust wind.",
        )

    @app.capability(description="Set ambient temperature in Celsius within the planet's valid range. Display/state only; does not affect rigid bodies.")
    async def set_temperature(planet: str, celsius: float) -> dict[str, Any]:
        return _propose("set_temperature", {"celsius": celsius}, planet, "Adjust temperature.")

    @app.capability(description="Set the manual surface traction multiplier (0.2..1.5). 1.0 is nominal; lower is more slippery.")
    async def set_surface_traction(planet: str, multiplier: float) -> dict[str, Any]:
        return _propose("set_surface_traction", {"multiplier": multiplier}, planet, "Adjust traction.")

    @app.capability(
        description="""Start a scheduled weather event. Types: rain (Earth only), cloud (Earth only), dust-storm (Mars only), wind (both), temperature (both). Targets: wind {x,y,z} m/s vector, precipitation mm/h, dustTau 0..5, temperature Kelvin, cloudOpacity 0..1. Envelope phases in seconds: delay, rampUp, hold, rampDown. IMPORTANT: there is NO hurricane/tornado/blizzard capability — Mars's thin atmosphere cannot support terrestrial hurricanes. If asked for one, do NOT silently substitute; call ask_clarification offering a dust storm instead."""
    )
    async def start_weather_event(
        planet: str,
        type: str,
        targets: dict[str, Any],
        delay: float = 0,
        rampUp: float = 5,
        hold: float = 30,
        rampDown: float = 5,
        priority: float = 1,
    ) -> dict[str, Any]:
        return _propose(
            "start_weather_event",
            {
                "type": type,
                "targets": targets,
                "delay": delay,
                "rampUp": rampUp,
                "hold": hold,
                "rampDown": rampDown,
                "priority": priority,
            },
            planet,
            f"Start {type} event.",
        )

    @app.capability(description="Stop a running weather event by its id.")
    async def stop_weather_event(planet: str, id: str) -> dict[str, Any]:
        return _propose("stop_weather_event", {"id": id}, planet, "Stop weather event.")

    @app.capability(description="Set a manual solar multiplier 0..1 (experimental shade) composed with cloud/dust attenuation. 1 is unmodified.")
    async def set_solar_illumination(planet: str, multiplier: float) -> dict[str, Any]:
        return _propose("set_solar_illumination", {"multiplier": multiplier}, planet, "Adjust sunlight.")

    @app.capability(description="Regenerate terrain from a seed (omit for a fresh random seed). Same seed reproduces the same terrain. Requires user confirmation.")
    async def regenerate_terrain(planet: str, seed: float | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if seed is not None:
            params["seed"] = int(seed)
        return _propose("regenerate_terrain", params, planet, "Regenerate terrain.")

    @app.capability(description="Pause physics stepping and event progression.")
    async def pause_simulation(planet: str) -> dict[str, Any]:
        return _propose("pause_simulation", {}, planet, "Pause simulation.")

    @app.capability(description="Resume physics stepping and event progression.")
    async def resume_simulation(planet: str) -> dict[str, Any]:
        return _propose("resume_simulation", {}, planet, "Resume simulation.")

    @app.capability(description="Clear all events and restore planet base conditions. Requires user confirmation.")
    async def reset_environment(planet: str) -> dict[str, Any]:
        return _propose("reset_environment", {}, planet, "Reset environment.")

    @app.capability(description="Apply a named scenario preset (Earth: earth-clear, earth-rain, earth-wind, earth-wet; Mars: mars-clear, mars-light-dust, mars-severe-storm, mars-low-solar). Requires user confirmation.")
    async def apply_scenario(planet: str, scenario_id: str) -> dict[str, Any]:
        return _propose("apply_scenario", {"scenario_id": scenario_id}, planet, f"Apply scenario {scenario_id}.")

    @app.capability(description="Ask the user a clarifying question when the request is ambiguous, or to offer a physically valid alternative instead of silently substituting (e.g. dust storm instead of a Martian hurricane).")
    async def ask_clarification(planet: str, question: str) -> dict[str, Any]:
        return {"clarification": question}

    @app.capability(description="Answer a question about current world conditions, telemetry, or forces acting on bodies, grounded in the live snapshot. Use for questions, never for changes.")
    async def explain_world(planet: str, topic: str) -> dict[str, Any]:
        return {"explanation_request": topic}

    @app.capability(description="Explicitly decline an impossible or unsupported request with a reason and, when possible, a supported alternative suggestion.")
    async def report_unsupported(planet: str, reason: str, suggestion: str = "") -> dict[str, Any]:
        return {"unsupported": reason, "suggestion": suggestion}


def build_orchestrator(llm: BaseLLM | None, planner_dir: str | None = None) -> Orchestrator:
    from pathlib import Path

    directory = planner_dir or str(Path(__file__).resolve().parent / "data" / "planner")
    app: Orchestrator = Orchestrator(
        "ark-mission-control",
        llm=llm,  # type: ignore[arg-type]
        planner_dir=directory,
        synthesis_guidance=SYNTHESIS_GUIDANCE,
    )
    register_world_capabilities(app)
    return app


class MissionAgent:
    """CSP-backed mission agent. interpret() proposes validated actions;
    respond() summarizes verified outcomes. No physics happens here."""

    def __init__(self, llm: BaseLLM | None = None, planner_dir: str | None = None) -> None:
        self._llm = llm
        self._app = build_orchestrator(llm, planner_dir=planner_dir)
        self._pending_synthesis: dict[str, dict[str, Any]] = {}
        self._restore_approved()

    @property
    def orchestrator(self) -> Orchestrator:
        return self._app

    @property
    def has_llm(self) -> bool:
        return self._llm is not None

    def list_capabilities(self) -> list[dict[str, Any]]:
        infos: list[dict[str, Any]] = []
        for name in REGISTERED_WORLD_COMMANDS + META_CAPABILITIES:
            infos.append({"name": name, "kind": "registered", "version": "4.0.0"})
        for name, entry in load_approved().items():
            infos.append(
                {
                    "name": name,
                    "kind": "synthesized",
                    "version": str(entry.get("version", "1")),
                    "description": str(entry.get("description", "")),
                }
            )
        return infos

    async def interpret(self, message: str, world_state: dict[str, Any]) -> InterpretResult:
        if self._llm is None:
            raise AgentNotConfigured(
                "No LLM credentials configured. Set GEMINI_API_KEY (Google AI Studio) "
                "or ANTHROPIC_API_KEY — easiest via the Mission AI tab's Agent Link setup."
            )
        planet = str(world_state.get("planet", "earth"))
        if planet not in ("earth", "mars"):
            return InterpretResult(status="error", message="", error=f"Unknown planet {planet!r}.")
        goal = self._build_goal(message, planet, world_state)
        try:
            result = await self._app.run_goal(goal)
        except Exception as exc:  # LLM/transport failure surfaces honestly
            return InterpretResult(status="error", message="", error=f"Planning failed: {exc}")
        return await self._map_result(result, planet, world_state, message)

    async def respond(
        self, message: str, results: list[dict[str, Any]], world_state: dict[str, Any]
    ) -> str:
        """Summarize VERIFIED execution results. Falls back to a labeled template."""
        if self._llm is None:
            return template_summary(results, world_state) + "\n\n(Template summary — LLM unavailable.)"
        prompt = (
            "Summarize these verified ARK simulation outcomes for the operator in 2-4 sentences. "
            "Report ONLY what the execution results and world snapshot show; never invent effects. "
            "Mention failures plainly if any outcome is not 'executed'/'read'.\n\n"
            f"Operator request: {message}\n"
            f"Execution results: {json.dumps(results)[:4000]}\n"
            f"World snapshot: {json.dumps(world_state)[:4000]}"
        )
        try:
            response = await self._llm.complete_once(prompt, max_tokens=400)
            return response.content.strip()
        except Exception as exc:
            return template_summary(results, world_state) + f"\n\n(LLM summary failed: {exc})"

    async def approve_synthesis(self, name: str) -> dict[str, Any]:
        """Approve a pending synthesized capability: re-validate, persist, and
        register a trusted wrapper that returns its validated steps as actions."""
        pending = self._pending_synthesis.get(name)
        if pending is None:
            raise KeyError(f"No pending synthesis named {name!r}.")
        planet = str(pending["planet"])
        validation = validate_synthesis_spec({"steps": pending["steps"]}, planet)
        if not validation.ok:
            raise ValueError(f"Synthesis failed re-validation: {'; '.join(validation.errors)}")
        entry = {
            "version": "1",
            "description": str(pending.get("description", "")),
            "planet": planet,
            "steps": validation.steps,
        }
        save_approved(name, entry)
        self._register_approved_wrapper(name, entry)
        del self._pending_synthesis[name]
        actions = [self._step_to_action(step, planet, f"Approved synthesis {name}") for step in validation.steps]
        return {"approved": True, "actions": actions}

    async def call_approved(self, name: str, planet: str) -> Any:
        return await self._app.call_capability(name, planet=planet)

    def _restore_approved(self) -> None:
        for name, entry in load_approved().items():
            if isinstance(entry, dict) and isinstance(entry.get("steps"), list):
                self._register_approved_wrapper(name, entry)

    def _register_approved_wrapper(self, name: str, entry: dict[str, Any]) -> None:
        description = str(entry.get("description", "Approved synthesized ARK capability."))
        steps = entry["steps"]

        async def _wrapper(planet: str) -> dict[str, Any]:
            actions = [self._step_to_action(step, planet, f"Synthesized {name}") for step in steps]
            return {"synthesized_actions": actions}

        _wrapper.__name__ = name
        self._app.capability(name=name, description=description)(_wrapper)

    @staticmethod
    def _step_to_action(step: dict[str, Any], planet: str, rationale: str) -> dict[str, Any]:
        normalized = validate_command(str(step["command"]), step.get("params", {}), planet)
        return {
            "command_id": uuid.uuid4().hex,
            "command": normalized.command,
            "params": normalized.params,
            "requires_confirmation": True,  # synthesized actions always confirm
            "reversible": normalized.reversible,
            "warnings": normalized.warnings,
            "rationale": rationale,
        }

    def _build_goal(self, message: str, planet: str, world_state: dict[str, Any]) -> str:
        env = world_state.get("environment", {}) if isinstance(world_state, dict) else {}
        summary = {
            "planet": planet,
            "simTime": world_state.get("simTime"),
            "wind": env.get("wind"),
            "precipitation": env.get("precipitation"),
            "dustTau": env.get("dustTau"),
            "temperatureK": env.get("temperature"),
            "solarMultiplier": env.get("solarMultiplier"),
            "activeEvents": env.get("activeEventIds"),
        }
        return (
            "You are the ARK Mission Control planner operating a real physics simulation. "
            "Propose actions ONLY via the registered capabilities with exact arguments. "
            "Always pass the active planet to every capability.\n"
            "Physical-consistency rules: Mars has a thin atmosphere (0.02 kg/m^3) — terrestrial "
            "hurricanes/tornadoes are impossible there; if asked, call ask_clarification offering "
            "a dust storm instead and NEVER silently substitute. Gravity changes are experimental "
            "overrides, allowed but flagged. Temperature is display/state only. Rain and cloud run "
            "only on Earth; dust storms only on Mars. For questions about current conditions or "
            "forces, call explain_world. If the request is ambiguous, call ask_clarification. "
            "If it is impossible with these capabilities, call report_unsupported. "
            "Never return an empty plan: vague follow-ups that reference a previous "
            "question must still call ask_clarification with a concrete question.\n"
            f"Active planet: {planet}\n"
            f"World snapshot: {json.dumps(summary)}\n"
            f"Operator request: {message}"
        )

    async def _map_result(
        self, result: dict[str, Any], planet: str, world_state: dict[str, Any], message: str
    ) -> InterpretResult:
        output = result.get("output", {}) if isinstance(result, dict) else {}
        if not isinstance(output, dict):
            output = {}
        capability_ids = sorted(str(key) for key in output)

        for name, payload in output.items():
            if not isinstance(payload, dict):
                continue
            if "unsupported" in payload:
                reason = str(payload.get("unsupported", ""))
                suggestion = str(payload.get("suggestion", ""))
                text = reason + (f" Alternative: {suggestion}" if suggestion else "")
                return InterpretResult(status="unsupported", message=text, capability_ids=capability_ids)
            if "clarification" in payload:
                return InterpretResult(
                    status="clarification",
                    message=str(payload.get("clarification", "")),
                    capability_ids=capability_ids,
                )
            if "explanation_request" in payload:
                answer = await self._explain(
                    str(payload.get("explanation_request", "")), world_state, message
                )
                return InterpretResult(
                    status="proposed",
                    message=answer,
                    capability_ids=capability_ids,
                )

        actions: list[ProposedAction] = []
        for name, payload in output.items():
            if not isinstance(payload, dict):
                continue
            if "action" in payload and isinstance(payload["action"], dict):
                action = payload["action"]
                actions.append(
                    ProposedAction(
                        command_id=str(action.get("command_id", uuid.uuid4().hex)),
                        command=str(action.get("command", "")),
                        params=dict(action.get("params", {})),
                        requires_confirmation=bool(action.get("requires_confirmation", False)),
                        reversible=bool(action.get("reversible", False)),
                        warnings=list(action.get("warnings", [])),
                        rationale=str(action.get("rationale", "")),
                    )
                )
            if "synthesized_actions" in payload and isinstance(payload["synthesized_actions"], list):
                for item in payload["synthesized_actions"]:
                    if isinstance(item, dict):
                        actions.append(
                            ProposedAction(
                                command_id=str(item.get("command_id", uuid.uuid4().hex)),
                                command=str(item.get("command", "")),
                                params=dict(item.get("params", {})),
                                requires_confirmation=True,
                                reversible=bool(item.get("reversible", False)),
                                warnings=list(item.get("warnings", [])),
                                rationale=str(item.get("rationale", "")),
                            )
                        )
        if actions:
            return InterpretResult(
                status="proposed",
                message="",
                actions=actions,
                capability_ids=capability_ids,
            )

        # No known outputs: either synthesis produced something new or planning failed.
        synthesized = {
            name: payload
            for name, payload in output.items()
            if name not in set(REGISTERED_WORLD_COMMANDS) | set(META_CAPABILITIES)
        }
        if synthesized:
            name, payload = next(iter(synthesized.items()))
            return await self._handle_synthesis(
                name, payload if isinstance(payload, dict) else {}, planet
            )

        errors = result.get("errors", []) if isinstance(result, dict) else []
        parts = [str(error) for error in errors]
        if isinstance(result, dict):
            # CSP failure envelopes carry the cause in "error"/"summary", not
            # always in "errors" — never swallow it behind a generic message.
            for key in ("error", "summary"):
                value = result.get(key)
                if value and str(value) not in parts:
                    parts.append(str(value))
        detail = "; ".join(parts)[:600] if parts else "no actionable plan"
        if isinstance(result, dict) and str(result.get("status", "OK")).upper() != "OK":
            return InterpretResult(status="error", message="", error=detail)
        # Planner returned nothing usable (e.g. an empty plan for a vague
        # follow-up): invite a concrete rephrase instead of a dead end.
        hint = f" ({detail})" if detail != "no actionable plan" else ""
        return InterpretResult(
            status="clarification",
            message=(
                "I couldn't build a plan from that — each message is interpreted "
                "on its own, so please send one complete instruction with all "
                "needed values (e.g. 'set wind to 12 m/s from the west')." + hint
            ),
            capability_ids=capability_ids,
        )

    async def _handle_synthesis(
        self, name: str, payload: dict[str, Any], planet: str
    ) -> InterpretResult:
        # Forget the raw synthesized code immediately (registry + files): only a
        # validated declarative spec may survive, and only after explicit approval.
        try:
            await self._app.forget(name)
        except Exception:
            pass
        description = str(payload.get("description", ""))
        validation = validate_synthesis_spec(payload, planet)
        if not validation.ok:
            return InterpretResult(
                status="missing_capability",
                message=f"Synthesis for {name!r} failed validation and was rejected: {'; '.join(validation.errors)}",
                missing_capability={"name": name, "description": description},
            )
        self._pending_synthesis[name] = {
            "description": description,
            "steps": validation.steps,
            "planet": planet,
        }
        return InterpretResult(
            status="synthesis_proposed",
            message=f"New capability {name!r} synthesized and validated. Approve to register it.",
            capability_ids=[name],
            synthesis={
                "name": name,
                "version": "1",
                "description": description,
                "steps": validation.steps,
                "validation": {"ok": True, "errors": []},
            },
        )


    async def _explain(self, topic: str, world_state: dict[str, Any], message: str) -> str:
        """Grounded explanation from the live snapshot. Never invents state."""
        if self._llm is None:
            return template_summary([], world_state)
        prompt = (
            "Answer this operator question about the ARK simulation using ONLY the "
            "world snapshot below. Quantities, units, and active events must come "
            "from the snapshot. If the snapshot lacks the answer, say what is "
            "missing instead of guessing.\n\n"
            f"Question: {message} (topic: {topic})\n"
            f"World snapshot: {json.dumps(world_state)[:6000]}"
        )
        try:
            response = await self._llm.complete_once(prompt, max_tokens=500)
            return response.content.strip()
        except Exception as exc:
            return f"Live explanation unavailable ({exc}). Snapshot: t={world_state.get('simTime')}s."


def template_summary(results: list[dict[str, Any]], world_state: dict[str, Any]) -> str:
    """Deterministic fallback summary used when the LLM is unavailable."""
    if not results:
        return "No commands were executed."
    lines = []
    for result in results:
        outcome = result.get("outcome", "?")
        command = result.get("command", "?")
        if outcome in ("executed", "read"):
            lines.append(f"- {command}: {result.get('message', 'done')}.")
        else:
            lines.append(f"- {command}: {outcome} ({result.get('error') or result.get('message', '')}).")
    planet = world_state.get("planet", "?") if isinstance(world_state, dict) else "?"
    sim_time = world_state.get("simTime", "?") if isinstance(world_state, dict) else "?"
    lines.append(f"World: {planet} at t={sim_time}s.")
    return "\n".join(lines)





class FakeLLM:
    """Scripted stand-in implementing the BaseLLM complete path for tests."""

    name = "fake"

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls: list[list[dict[str, str]]] = []

    async def complete(self, messages, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append([{"role": message.role, "content": message.content} for message in messages])
        if not self._responses:
            raise AssertionError("FakeLLM exhausted its scripted responses.")
        return LLMResponse(content=self._responses.pop(0))

    async def complete_once(self, prompt, **kwargs):  # type: ignore[no-untyped-def]
        from csp.llm.base import LLMMessage

        return await self.complete([LLMMessage(role="user", content=prompt)], **kwargs)
