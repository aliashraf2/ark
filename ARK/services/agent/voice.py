"""ElevenLabs transport only: no planner, tools, or simulator in this module."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import AsyncIterator
from urllib.parse import urlparse

import httpx
from elevenlabs import AsyncElevenLabs, VoiceSettings
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, SecretStr


@dataclass(frozen=True)
class VoiceConfig:
    api_key: str = field(repr=False)
    voice_id: str
    model_id: str
    language: str

    @classmethod
    def from_env(cls) -> VoiceConfig:
        return cls(
            os.getenv("ELEVENLABS_API_KEY", "").strip(),
            os.getenv("ELEVENLABS_VOICE_ID", "").strip(),
            os.getenv("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5").strip(),
            os.getenv("ELEVENLABS_LANGUAGE", "en").strip(),
        )

    def problem(self) -> str | None:
        if not self.api_key:
            return "Connect ElevenLabs using the API key form in Voice Mission Control."
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.voice_id):
            return "Set ELEVENLABS_VOICE_ID to a voice available to your account."
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.model_id):
            return "ELEVENLABS_TTS_MODEL must be a valid model identifier."
        if self.language != "en":
            return "This ARK voice integration currently supports English (en) only."
        return None


def voice_access(request: Request) -> None:
    """Reject cross-site spending in local and authenticated public deployments.

    CORS alone isn't authorization. The custom header forces a preflight and we
    also validate Origin/Host on the actual request, before contacting ElevenLabs.
    Public deployments first pass the authenticated gateway middleware.
    """
    if getattr(request.app.state, "public_origin", ""):
        # PublicAccessMiddleware already checked the gateway token, Host and
        # exact origin. Retain the voice-specific preflight/client header.
        if request.headers.get("x-ark-voice") != "1":
            raise HTTPException(403, "Missing voice client header.")
        return
    host = request.url.hostname
    if host not in {"localhost", "127.0.0.1", "::1", "testserver"}:
        raise HTTPException(403, "Voice API is available on localhost only.")
    if request.headers.get("x-ark-voice") != "1":
        raise HTTPException(403, "Missing voice client header.")
    origin = request.headers.get("origin")
    if origin:
        configured = os.getenv("ARK_CORS_ORIGINS", "")
        if configured:
            allowed = origin in {item.strip() for item in configured.split(",")}
        else:
            parsed = urlparse(origin)
            allowed = parsed.scheme in {"http", "https"} and parsed.hostname in {
                "localhost", "127.0.0.1", "::1"
            }
        if not allowed:
            raise HTTPException(403, "Voice origin is not allowed.")


def current_voice(request: Request) -> VoiceConfig:
    return getattr(request.app.state, "voice_config", None) or VoiceConfig.from_env()


def configured_voice(request: Request) -> VoiceConfig:
    config = current_voice(request)
    if problem := config.problem():
        raise HTTPException(503, problem)
    return config


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    language: str = "en"


class ConfigureVoiceRequest(BaseModel):
    api_key: SecretStr
    voice_id: str = Field(default="", max_length=128, pattern=r"^[A-Za-z0-9_-]*$")
    model_id: str = Field(default="eleven_flash_v2_5", min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


router = APIRouter(prefix="/api/voice", dependencies=[Depends(voice_access)])


@router.get("/config")
async def config(request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    settings = current_voice(request)
    return {
        "configured": settings.problem() is None,
        "error": settings.problem(),
        "languages": ["en"],
        "language": settings.language,
        "stt_model": "scribe_v2_realtime",
        "tts_model": settings.model_id,
        "voice_id": settings.voice_id,
        "source": "dashboard" if getattr(request.app.state, "voice_config", None) else "environment",
        "llm_ready": request.app.state.agent.has_llm,
    }


@router.post("/configure")
async def configure(body: ConfigureVoiceRequest, request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    key = body.api_key.get_secret_value().strip()
    if not 8 <= len(key) <= 500:
        raise HTTPException(422, "Enter a valid ElevenLabs API key.")
    try:
        async with httpx.AsyncClient(timeout=15) as transport:
            client = AsyncElevenLabs(api_key=key, httpx_client=transport)
            # Probe STT permission without exposing or persisting the token.
            await client.tokens.single_use.create("realtime_scribe")
            if body.voice_id:
                voice_id = body.voice_id
                voice_name = voice_id
            else:
                available = await client.voices.search(page_size=100)
                if not available.voices:
                    raise HTTPException(422, "No account voices found. Add a voice in ElevenLabs or enter its voice ID.")
                selected = available.voices[0]
                voice_id = selected.voice_id
                voice_name = selected.name or voice_id
            candidate = VoiceConfig(key, voice_id, body.model_id, "en")
            if problem := candidate.problem():
                raise HTTPException(422, problem)
            # Verify TTS/voice/model access before replacing a working setup.
            # This short connection check consumes a small amount of TTS credit.
            probe = client.text_to_speech.stream(
                voice_id=voice_id, text="Voice connected.", model_id=body.model_id,
                language_code="en", output_format="pcm_24000",
            )
            try:
                await anext(probe)
            finally:
                await probe.aclose()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Could not connect ElevenLabs. Check key permissions, voice/model access and quota. Auto-selecting a voice also needs Voices read permission; alternatively enter a voice ID.") from None
    # Session-local backend memory only. No .env, disk, browser storage or key echo.
    request.app.state.voice_config = candidate
    return {"configured": True, "voice_id": voice_id, "voice_name": voice_name, "tts_model": body.model_id, "source": "dashboard"}


@router.post("/token")
async def token(response: Response, settings: VoiceConfig = Depends(configured_voice)) -> dict:
    response.headers["Cache-Control"] = "no-store"
    try:
        async with httpx.AsyncClient(timeout=15) as transport:
            client = AsyncElevenLabs(api_key=settings.api_key, httpx_client=transport)
            result = await client.tokens.single_use.create("realtime_scribe")
            return {"token": result.token}
    except Exception:
        # SDK exception bodies can include provider internals; never return/log them.
        raise HTTPException(502, "ElevenLabs could not authorize transcription. Check key permissions and quota.") from None


@router.post("/speech")
async def speech(body: SpeechRequest, settings: VoiceConfig = Depends(configured_voice)):
    if body.language != "en":
        raise HTTPException(422, "Only English (en) is enabled.")
    # Open and prime the iterator BEFORE headers, so auth/model errors produce a
    # real HTTP error. The generator owns both transports until completion/cancel.
    transport = httpx.AsyncClient(timeout=30)
    client = AsyncElevenLabs(api_key=settings.api_key, httpx_client=transport)
    stream = client.text_to_speech.stream(
        voice_id=settings.voice_id,
        text=body.text,
        model_id=settings.model_id,
        language_code="en",
        output_format="pcm_24000",
        voice_settings=VoiceSettings(stability=0.65, similarity_boost=0.75, style=0.0, speed=1.0),
    )
    try:
        first = await anext(stream)
    except BaseException as exc:
        await stream.aclose()
        await transport.aclose()
        if not isinstance(exc, Exception):
            raise
        raise HTTPException(502, "ElevenLabs speech is unavailable. Check voice, model, key permissions and quota.") from None

    async def chunks() -> AsyncIterator[bytes]:
        try:
            yield first
            async for chunk in stream:
                yield chunk
        except Exception:
            raise RuntimeError("ElevenLabs speech stream interrupted.") from None
        finally:
            await stream.aclose()
            await transport.aclose()

    return StreamingResponse(chunks(), media_type="application/octet-stream", headers={
        "Cache-Control": "no-store", "X-Accel-Buffering": "no",
        "X-Audio-Format": "pcm_s16le_24000",
    })
