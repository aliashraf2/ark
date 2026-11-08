"""LLM providers for ARK Mission Control.

CSP ships Anthropic support, and BaseLLM is its documented extension point.
Gemini and Meta Muse use small BaseLLM adapters over their public REST APIs.
No CSP internals are touched: the planner, executor, and sandbox all consume
the same complete()/complete_once() interface.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from csp import AnthropicLLM, BaseLLM, LLMMessage, LLMResponse

GEMINI_DEFAULT_MODEL = "gemini-2.5-flash"
GEMINI_API_HOST = "https://generativelanguage.googleapis.com"
MUSE_DEFAULT_MODEL = "muse-spark-1.3"
MUSE_API_URL = "https://api.meta.ai/v1/chat/completions"


@dataclass(frozen=True)
class LLMConfig:
    provider: str  # "gemini" | "anthropic" | "muse" | "custom"
    model: str


class GeminiLLM(BaseLLM):
    """Google AI Studio (Gemini) provider via the public REST API."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        model: str | None = None,
        default_system: str | None = None,
        timeout_s: float = 60.0,
    ) -> None:
        key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
        if not key:
            raise ValueError("Gemini API key required (GEMINI_API_KEY or GOOGLE_API_KEY).")
        self._api_key = key
        self._model = model or os.environ.get("GEMINI_MODEL", GEMINI_DEFAULT_MODEL)
        self._default_system = default_system
        self._timeout_s = timeout_s

    @property
    def model(self) -> str:
        return self._model

    async def complete(
        self,
        messages: list[LLMMessage],
        *,
        max_tokens: int = 4096,
        temperature: float = 0.0,
        system: Optional[str] = None,
    ) -> LLMResponse:
        system_prompt = system or self._default_system
        contents: list[dict[str, Any]] = []
        for message in messages:
            if message.role == "system":
                system_prompt = f"{system_prompt}\n{message.content}" if system_prompt else message.content
                continue
            role = "model" if message.role == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": message.content}]})
        if not contents:
            raise ValueError("Gemini called with no user/assistant messages.")
        body: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
        if system_prompt:
            body["system_instruction"] = {"parts": [{"text": system_prompt}]}
        url = f"{GEMINI_API_HOST}/v1beta/models/{self._model}:generateContent"
        try:
            async with httpx.AsyncClient(timeout=self._timeout_s) as client:
                response = await client.post(
                    url, json=body, headers={"x-goog-api-key": self._api_key}
                )
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Gemini request failed: {exc}") from exc
        if response.status_code != 200:
            raise RuntimeError(
                f"Gemini API error {response.status_code}: {response.text[:300]}"
            )
        data = response.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise RuntimeError(f"Gemini returned no candidates: {str(data)[:300]}")
        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
        usage = data.get("usageMetadata", {})
        return LLMResponse(
            content=text,
            input_tokens=int(usage.get("promptTokenCount", 0)),
            output_tokens=int(usage.get("candidatesTokenCount", 0)),
            stop_reason=candidates[0].get("finishReason"),
        )


class MuseLLM(BaseLLM):
    """Meta Muse via its documented Chat Completions API and CSP's public interface.

    CSP owns orchestration and history. This adapter only exchanges text; Meta
    never receives simulation tool execution authority or a competing agent loop.
    """

    def __init__(self, api_key: str | None = None, *, model: str | None = None, timeout_s: float = 60.0) -> None:
        self._api_key = (api_key or os.getenv("MUSE_API_KEY") or os.getenv("MODEL_API_KEY", "")).strip()
        if not self._api_key:
            raise ValueError("Muse API key required (MUSE_API_KEY or MODEL_API_KEY).")
        self._model = model or os.getenv("MUSE_MODEL", MUSE_DEFAULT_MODEL)
        self._timeout_s = timeout_s

    @property
    def model(self) -> str:
        return self._model

    async def complete(self, messages: list[LLMMessage], *, max_tokens: int = 4096,
                       temperature: float = 0.0, system: Optional[str] = None) -> LLMResponse:
        if not any(message.role in {"user", "assistant"} for message in messages):
            raise ValueError("Muse called with no user/assistant messages.")
        payload = [{"role": message.role, "content": message.content} for message in messages]
        if system:
            payload.insert(0, {"role": "system", "content": system})
        body = {
            "model": self._model, "messages": payload, "temperature": temperature,
            # The limit includes reasoning tokens. The existing setup probe asks
            # for 20 visible tokens; reserve enough for Muse's reasoning as well.
            "max_completion_tokens": max(2048, max_tokens), "reasoning_effort": "low",
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout_s) as client:
                response = await client.post(MUSE_API_URL, json=body, headers={"Authorization": f"Bearer {self._api_key}"})
        except httpx.HTTPError:
            raise RuntimeError("Muse request failed. Check the network and retry.") from None
        if response.status_code != 200:
            # Do not echo provider error bodies: they may contain private inputs.
            raise RuntimeError(f"Muse API error {response.status_code}. Check the key, model access and quota.")
        try:
            data = response.json()
            choice = data["choices"][0]
            text = choice["message"]["content"]
            finish = choice.get("finish_reason")
            if finish == "length":
                raise ValueError("truncated")
            if not isinstance(text, str) or not text.strip():
                raise ValueError("empty")
            usage = data.get("usage") or {}
            return LLMResponse(content=text, input_tokens=int(usage.get("prompt_tokens", 0)),
                               output_tokens=int(usage.get("completion_tokens", 0)), stop_reason=finish)
        except (KeyError, IndexError, TypeError, ValueError):
            raise RuntimeError("Muse returned an empty, malformed or incomplete answer. No commands were applied by the model.") from None


def create_llm(provider: str, api_key: str, model: str | None = None) -> BaseLLM:
    """Build a provider LLM explicitly (used by UI-driven setup)."""
    normalized = provider.strip().lower()
    if not api_key or not api_key.strip():
        raise ValueError("API key must not be empty.")
    if normalized == "gemini":
        return GeminiLLM(api_key=api_key.strip(), model=model.strip() if model else None)
    if normalized == "anthropic":
        return AnthropicLLM(api_key=api_key.strip(), model=model.strip() if model else None)
    if normalized == "muse":
        return MuseLLM(api_key=api_key.strip(), model=model.strip() if model else None)
    raise ValueError(f'Unknown LLM provider "{provider}" (expected "gemini", "anthropic" or "muse").')


def create_llm_from_env() -> tuple[BaseLLM | None, LLMConfig | None]:
    """Honor the dashboard selection on restart; otherwise retain legacy priority."""
    providers = {
        "gemini": (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"), os.getenv("GEMINI_MODEL") or GEMINI_DEFAULT_MODEL),
        "anthropic": (os.getenv("ANTHROPIC_API_KEY"), os.getenv("ANTHROPIC_MODEL") or "claude-haiku-4-5-20251001"),
        "muse": (os.getenv("MUSE_API_KEY") or os.getenv("MODEL_API_KEY"), os.getenv("MUSE_MODEL") or MUSE_DEFAULT_MODEL),
    }
    selected = os.getenv("ARK_LLM_PROVIDER", "").strip().lower()
    for provider in ([selected] if selected else providers):
        key, model = providers.get(provider, (None, None))
        if key and model:
            return create_llm(provider, key, model), LLMConfig(provider, model)
    return None, None
