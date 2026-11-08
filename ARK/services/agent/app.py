"""ARK Mission Control backend: FastAPI service bridging natural language
and the browser simulator through CSP-orchestrated, validated world commands.

Request flow (HTTP MVP):
  1. POST /api/mission/interpret  -> proposed actions (never executes physics)
  2. Simulator validates + executes via its command dispatcher
  3. POST /api/mission/respond    -> grounded summary of VERIFIED outcomes

No physics world exists here. Success is reported only from simulator
acknowledgement.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from agent import AgentNotConfigured, MissionAgent
from llm import LLMConfig, create_llm, create_llm_from_env
from world_commands import load_protocol


def env_file_path() -> Path:
    override = os.environ.get("ARK_ENV_PATH")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent / ".env"


def load_env_file() -> None:
    """Load KEY=VALUE pairs from the service .env (no extra dependency).

    Only fills variables that are not already set; real environment wins.
    """
    path = env_file_path()
    if not path.exists():
        return
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and value and key not in os.environ:
            os.environ[key] = value


def write_env_key(key: str, value: str) -> Path:
    """Persist one KEY=VALUE pair to the service .env (mode 600)."""
    path = env_file_path()
    lines: list[str] = []
    if path.exists():
        try:
            lines = path.read_text().splitlines()
        except OSError:
            lines = []
    updated = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(f"{key}=") or stripped.startswith(f"{key} ="):
            lines[index] = f"{key}={value}"
            updated = True
    if not updated:
        lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


class InterpretRequest(BaseModel):
    request_id: str
    message: str = Field(min_length=1, max_length=2000)
    world_state: dict[str, Any]


class ActionModel(BaseModel):
    command_id: str
    command: str
    params: dict[str, Any] = {}
    requires_confirmation: bool = False
    reversible: bool = False
    warnings: list[str] = []
    rationale: str = ""


class InterpretResponse(BaseModel):
    request_id: str
    status: str
    message: str = ""
    actions: list[ActionModel] = []
    capability_ids: list[str] = []
    missing_capability: dict[str, str] | None = None
    synthesis_spec: dict[str, Any] | None = None
    error: str | None = None


class ExecutionResultModel(BaseModel):
    command_id: str
    command: str
    outcome: str
    message: str = ""
    error: str | None = None


class RespondRequest(BaseModel):
    request_id: str
    message: str = ""
    results: list[ExecutionResultModel] = []
    world_state: dict[str, Any] = {}


class RespondResponse(BaseModel):
    request_id: str
    reply: str


class ApproveRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class ApproveResponse(BaseModel):
    approved: bool
    actions: list[ActionModel] = []
    error: str | None = None


class ConfigureRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    api_key: str = Field(min_length=8, max_length=500)
    model: str | None = Field(default=None, max_length=128)


class ConfigureResponse(BaseModel):
    configured: bool
    provider: str | None = None
    model: str | None = None
    error: str | None = None


def create_app(
    llm: Any = None,
    llm_config: LLMConfig | None = None,
    planner_dir: str | None = None,
) -> FastAPI:
    """App factory. Tests inject a scripted FakeLLM; production reads env + .env."""
    load_env_file()
    resolved_llm = llm
    resolved_config = llm_config
    if resolved_llm is None:
        resolved_llm, resolved_config = create_llm_from_env()
    agent = MissionAgent(llm=resolved_llm, planner_dir=planner_dir)

    app = FastAPI(title="ARK Mission Control", version="4.0.0")
    cors_override = os.environ.get("ARK_CORS_ORIGINS")
    if cors_override:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_override.split(","),
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"],
        )
    else:
        # Localhost-only default: any local port (vite picks 5173, 5199, ...).
        app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"],
        )
    app.state.agent = agent
    app.state.planner_dir = planner_dir
    app.state.llm_config = resolved_config

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        protocol = load_protocol()
        config: LLMConfig | None = app.state.llm_config
        return {
            "status": "ok",
            "llm_configured": config is not None and app.state.agent.has_llm,
            "provider": config.provider if config else None,
            "model": config.model if config else None,
            "protocol": protocol.raw.get("protocol"),
            "protocol_version": protocol.raw.get("version"),
            "commands": len(protocol.commands),
        }

    @app.post("/api/mission/configure", response_model=ConfigureResponse)
    async def configure(request: ConfigureRequest) -> ConfigureResponse:
        """UI-driven setup: validate a pasted key with a live probe, then persist
        it to the server-side .env and hot-swap the agent's LLM (no restart)."""
        provider = request.provider.strip().lower()
        if provider not in ("gemini", "anthropic"):
            return ConfigureResponse(
                configured=False, error='Unknown provider (expected "gemini" or "anthropic").'
            )
        try:
            candidate = create_llm(provider, request.api_key, request.model)
        except ValueError as exc:
            return ConfigureResponse(configured=False, error=str(exc))
        try:
            probe = await candidate.complete_once("Reply with exactly: ok", max_tokens=20)
            if "ok" not in probe.content.lower():
                raise RuntimeError(f"unexpected probe reply: {probe.content[:100]!r}")
        except Exception as exc:
            return ConfigureResponse(
                configured=False, error=f"Key validation failed: {exc}"
            )
        model = getattr(candidate, "model", None) or getattr(candidate, "_model", None) or ""
        env_key = "GEMINI_API_KEY" if provider == "gemini" else "ANTHROPIC_API_KEY"
        write_env_key(env_key, request.api_key.strip())
        if provider == "gemini" and request.model:
            write_env_key("GEMINI_MODEL", request.model.strip())
        if provider == "anthropic" and request.model:
            write_env_key("ANTHROPIC_MODEL", request.model.strip())
        os.environ[env_key] = request.api_key.strip()
        app.state.agent = MissionAgent(llm=candidate, planner_dir=app.state.planner_dir)
        app.state.llm_config = LLMConfig(provider, str(model))
        return ConfigureResponse(configured=True, provider=provider, model=str(model))

    @app.get("/api/mission/capabilities")
    async def capabilities() -> dict[str, Any]:
        return {"capabilities": app.state.agent.list_capabilities()}

    @app.post("/api/mission/interpret", response_model=InterpretResponse)
    async def interpret(request: InterpretRequest) -> InterpretResponse:
        try:
            result = await app.state.agent.interpret(request.message, request.world_state)
        except AgentNotConfigured as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        return InterpretResponse(
            request_id=request.request_id,
            status=result.status,
            message=result.message,
            actions=[ActionModel(**action.__dict__) for action in result.actions],
            capability_ids=result.capability_ids,
            missing_capability=result.missing_capability,
            synthesis_spec=result.synthesis,
            error=result.error,
        )

    @app.post("/api/mission/respond", response_model=RespondResponse)
    async def respond(request: RespondRequest) -> RespondResponse:
        reply = await app.state.agent.respond(
            request.message,
            [result.model_dump() for result in request.results],
            request.world_state,
        )
        return RespondResponse(request_id=request.request_id, reply=reply)

    @app.post("/api/mission/approve_capability", response_model=ApproveResponse)
    async def approve_capability(request: ApproveRequest) -> ApproveResponse:
        try:
            outcome = await app.state.agent.approve_synthesis(request.name)
        except KeyError as exc:
            return ApproveResponse(approved=False, error=str(exc))
        except ValueError as exc:
            return ApproveResponse(approved=False, error=str(exc))
        actions = [ActionModel(**action) for action in outcome["actions"]]
        return ApproveResponse(approved=True, actions=actions)

    return app


app = create_app()
