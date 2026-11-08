"""LLM providers for ARK Mission Control.

CSP ships Anthropic support only, but BaseLLM is its documented extension
point ("developers pass their preferred implementation into Orchestrator"),
so Gemini arrives as a small BaseLLM subclass over the public Gemini REST API.
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


@dataclass(frozen=True)
class LLMConfig:
    provider: str  # "gemini" | "anthropic" | "custom"
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


def create_llm(provider: str, api_key: str, model: str | None = None) -> BaseLLM:
    """Build a provider LLM explicitly (used by UI-driven setup)."""
    normalized = provider.strip().lower()
    if not api_key or not api_key.strip():
        raise ValueError("API key must not be empty.")
    if normalized == "gemini":
        return GeminiLLM(api_key=api_key.strip(), model=model.strip() if model else None)
    if normalized == "anthropic":
        return AnthropicLLM(api_key=api_key.strip(), model=model.strip() if model else None)
    raise ValueError(f'Unknown LLM provider "{provider}" (expected "gemini" or "anthropic").')


def create_llm_from_env() -> tuple[BaseLLM | None, LLMConfig | None]:
    """Probe environment for a configured provider. Gemini first, then Anthropic."""
    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if gemini_key:
        model = os.environ.get("GEMINI_MODEL", GEMINI_DEFAULT_MODEL)
        return GeminiLLM(api_key=gemini_key, model=model), LLMConfig("gemini", model)
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        model = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
        return AnthropicLLM(api_key=anthropic_key), LLMConfig("anthropic", model)
    return None, None
