"""LLM provider factory + Gemini BaseLLM adapter (mocked transport)."""

from __future__ import annotations

import pytest

from llm import GEMINI_DEFAULT_MODEL, MUSE_DEFAULT_MODEL, MUSE_API_URL, GeminiLLM, MuseLLM, create_llm, create_llm_from_env


def test_create_llm_unknown_provider():
    with pytest.raises(ValueError, match="Unknown LLM provider"):
        create_llm("openai", "sk-test-12345678")


def test_create_llm_rejects_empty_key():
    with pytest.raises(ValueError, match="must not be empty"):
        create_llm("gemini", "   ")


def test_gemini_requires_key(agent_dirs):
    with pytest.raises(ValueError, match="Gemini API key required"):
        GeminiLLM()


def test_env_prefers_gemini_over_anthropic(agent_dirs, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "gem-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ant-key")
    llm, config = create_llm_from_env()
    assert isinstance(llm, GeminiLLM)
    assert config is not None and config.provider == "gemini"
    assert config.model == GEMINI_DEFAULT_MODEL


def test_env_falls_back_to_anthropic(agent_dirs, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ant-key")
    llm, config = create_llm_from_env()
    assert config is not None and config.provider == "anthropic"


def test_env_unconfigured(agent_dirs):
    llm, config = create_llm_from_env()
    assert llm is None and config is None


class _FakeResponse:
    status_code = 200
    text = "{}"

    def json(self):
        return {
            "candidates": [
                {
                    "content": {"parts": [{"text": "plan-json-here"}]},
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5},
        }


class _FakeClient:
    last_request: dict | None = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None):
        type(self).last_request = {"url": url, "json": json, "headers": headers}
        return _FakeResponse()


async def test_gemini_complete_maps_messages_and_system(agent_dirs, monkeypatch):
    import llm as llm_module
    from csp.llm.base import LLMMessage

    monkeypatch.setattr(llm_module.httpx, "AsyncClient", _FakeClient)
    adapter = GeminiLLM(api_key="test-key")
    response = await adapter.complete(
        [LLMMessage(role="user", content="hello")],
        system="sys-prompt",
        max_tokens=50,
        temperature=0.0,
    )
    assert response.content == "plan-json-here"
    assert response.input_tokens == 10
    assert response.output_tokens == 5
    sent = _FakeClient.last_request
    assert sent is not None
    assert "gemini-2.5-flash" in sent["url"]
    assert sent["headers"] == {"x-goog-api-key": "test-key"}
    assert sent["json"]["system_instruction"]["parts"][0]["text"] == "sys-prompt"
    assert sent["json"]["contents"][0]["role"] == "user"
    assert sent["json"]["generationConfig"]["maxOutputTokens"] == 50


def test_muse_factory_and_selected_provider_survive_restart(agent_dirs, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "existing-gemini-key")
    monkeypatch.setenv("MUSE_API_KEY", "muse-test-key")
    monkeypatch.setenv("MUSE_MODEL", "muse-spark-1.2")
    monkeypatch.setenv("ARK_LLM_PROVIDER", "muse")
    adapter, config = create_llm_from_env()
    assert isinstance(adapter, MuseLLM)
    assert config.provider == "muse"
    assert config.model == "muse-spark-1.2"
    assert isinstance(create_llm("muse", "test-key"), MuseLLM)


def test_muse_recognizes_meta_environment_key(agent_dirs, monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "meta-test-key")
    adapter, config = create_llm_from_env()
    assert isinstance(adapter, MuseLLM)
    assert config.model == MUSE_DEFAULT_MODEL


def test_selected_provider_never_silently_uses_another_key(agent_dirs, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "existing-key")
    monkeypatch.setenv("ARK_LLM_PROVIDER", "muse")
    assert create_llm_from_env() == (None, None)


async def test_muse_maps_csp_messages_and_reasoning_budget(agent_dirs, monkeypatch):
    import llm as module
    from csp import LLMMessage
    class Reply(_FakeResponse):
        def json(self):
            return {"choices": [{"message": {"content": "plan-json-here"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 12}}
    class Transport(_FakeClient):
        async def post(self, url, json=None, headers=None):
            _FakeClient.last_request = {"url": url, "json": json, "headers": headers}
            return Reply()
    monkeypatch.setattr(module.httpx, "AsyncClient", Transport)
    response = await MuseLLM(api_key="muse-private-key").complete([
        LLMMessage(role="system", content="rules"), LLMMessage(role="user", content="request"),
        LLMMessage(role="assistant", content="previous response")], system="mission", max_tokens=20)
    sent = _FakeClient.last_request
    assert sent["url"] == MUSE_API_URL
    assert sent["headers"] == {"Authorization": "Bearer muse-private-key"}
    assert sent["json"]["model"] == MUSE_DEFAULT_MODEL
    assert sent["json"]["messages"][0] == {"role": "system", "content": "mission"}
    assert sent["json"]["messages"][-1]["role"] == "assistant"
    assert sent["json"]["max_completion_tokens"] == 2048
    assert sent["json"]["reasoning_effort"] == "low"
    assert response.content == "plan-json-here"
    assert response.input_tokens == 11 and response.output_tokens == 12


@pytest.mark.parametrize("payload", [{}, {"choices": []}, {"choices": [{"message": {"content": ""}}]},
    {"choices": [{"message": {"content": "truncated plan"}, "finish_reason": "length"}]}])
async def test_muse_rejects_incomplete_responses(agent_dirs, monkeypatch, payload):
    import llm as module
    class Reply(_FakeResponse):
        def json(self): return payload
    class Transport(_FakeClient):
        async def post(self, *args, **kwargs): return Reply()
    monkeypatch.setattr(module.httpx, "AsyncClient", Transport)
    with pytest.raises(RuntimeError, match="empty, malformed or incomplete"):
        await MuseLLM(api_key="test-key").complete_once("plan")


async def test_muse_sanitizes_provider_errors(agent_dirs, monkeypatch):
    import llm as module
    class Reply(_FakeResponse):
        status_code = 401
        text = "muse-private-key"
    class Transport(_FakeClient):
        async def post(self, *args, **kwargs): return Reply()
    monkeypatch.setattr(module.httpx, "AsyncClient", Transport)
    with pytest.raises(RuntimeError) as error:
        await MuseLLM(api_key="muse-private-key").complete_once("plan")
    assert "401" in str(error.value)
    assert "muse-private-key" not in str(error.value)
