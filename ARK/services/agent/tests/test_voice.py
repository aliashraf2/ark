"""Voice transport/authentication tests; never contact ElevenLabs or use a real key."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import create_app
from voice import VoiceConfig

HEADERS = {"X-ARK-Voice": "1", "Origin": "http://localhost:5173"}


@pytest.fixture
def voice_client(agent_dirs, monkeypatch):
    for name in ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_TTS_MODEL", "ELEVENLABS_LANGUAGE", "ARK_CORS_ORIGINS"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(create_app(planner_dir=agent_dirs["planner"]))


@pytest.fixture
def provider(monkeypatch):
    import voice
    monkeypatch.setenv("ELEVENLABS_API_KEY", "private-test-key")
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "account-voice")
    calls = []
    closed = []

    async def create(kind):
        calls.append(("token", kind))
        return SimpleNamespace(token="temporary-test-token")

    async def stream(**kwargs):
        calls.append(("speech", kwargs))
        try:
            yield b"\x00\x00\x10\x00"
            yield b"\x20\x00"
        finally:
            closed.append(True)

    async def search(**kwargs):
        return SimpleNamespace(voices=[SimpleNamespace(voice_id="account-voice", name="Mission voice")])

    def sdk(**kwargs):
        assert kwargs["api_key"] == "private-test-key"
        return SimpleNamespace(tokens=SimpleNamespace(single_use=SimpleNamespace(create=create)), text_to_speech=SimpleNamespace(stream=stream), voices=SimpleNamespace(search=search))

    monkeypatch.setattr(voice, "AsyncElevenLabs", sdk)
    return calls, closed


def test_optional_configuration_does_not_break_mission_control(voice_client):
    assert voice_client.get("/api/health").status_code == 200
    result = voice_client.get("/api/voice/config", headers=HEADERS)
    assert result.json()["configured"] is False
    assert result.json()["languages"] == ["en"]
    assert voice_client.post("/api/voice/token", json={}, headers=HEADERS).status_code == 503


def test_config_requires_account_voice_and_english(voice_client, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "private-test-key")
    assert "VOICE_ID" in VoiceConfig.from_env().problem()
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "voice-id")
    monkeypatch.setenv("ELEVENLABS_LANGUAGE", "fr")
    assert "English" in VoiceConfig.from_env().problem()


def test_single_use_token_never_exposes_key(voice_client, provider):
    response = voice_client.post("/api/voice/token", json={}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"token": "temporary-test-token"}
    assert response.headers["cache-control"] == "no-store"
    assert provider[0] == [("token", "realtime_scribe")]
    config = voice_client.get("/api/voice/config", headers=HEADERS)
    assert config.json()["configured"] is True
    assert "private-test-key" not in config.text + response.text


@pytest.mark.parametrize("headers", [
    {}, {"Origin": "http://localhost:5173"},
    {"X-ARK-Voice": "1", "Origin": "https://attacker.example"},
    {"X-ARK-Voice": "1", "Origin": "http://localhost.attacker.example"},
    {"X-ARK-Voice": "1", "Host": "attacker.example"},
])
def test_rejects_cross_site_or_missing_header_before_spending(voice_client, provider, headers):
    assert voice_client.post("/api/voice/token", json={}, headers=headers).status_code == 403
    assert provider[0] == []


def test_honors_explicit_allowed_origins_and_preflight(voice_client, provider, monkeypatch):
    monkeypatch.setenv("ARK_CORS_ORIGINS", "http://localhost:5173")
    assert voice_client.post("/api/voice/token", json={}, headers={**HEADERS, "Origin": "http://localhost:9999"}).status_code == 403
    preflight = voice_client.options("/api/voice/token", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-ark-voice",
    })
    assert preflight.status_code == 200
    assert "x-ark-voice" in preflight.headers["access-control-allow-headers"].lower()


def test_streams_configured_voice_model_and_closes_iterator(voice_client, provider, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_TTS_MODEL", "account-model")
    response = voice_client.post("/api/voice/speech", headers=HEADERS, json={"text": "Verified simulation result.", "language": "en"})
    assert response.status_code == 200
    assert response.content == b"\x00\x00\x10\x00\x20\x00"
    assert response.headers["x-audio-format"] == "pcm_s16le_24000"
    assert response.headers["cache-control"] == "no-store"
    args = provider[0][0][1]
    assert args["text"] == "Verified simulation result."
    assert args["voice_id"] == "account-voice"
    assert args["model_id"] == "account-model"
    assert args["output_format"] == "pcm_24000"
    assert provider[1] == [True]


@pytest.mark.parametrize("body", [{"text": "hello", "language": "de"}, {"text": ""}, {"text": "x" * 4001}])
def test_invalid_speech_never_calls_provider(voice_client, provider, body):
    assert voice_client.post("/api/voice/speech", headers=HEADERS, json=body).status_code == 422
    assert provider[0] == []


def test_provider_errors_are_sanitized_before_stream_headers(voice_client, provider, monkeypatch):
    import voice
    async def bad_token(*args):
        raise RuntimeError("private-test-key provider details")
    async def bad_speech(**kwargs):
        raise RuntimeError("private-test-key provider details")
        yield b""  # async generator
    monkeypatch.setattr(voice, "AsyncElevenLabs", lambda **kw: SimpleNamespace(
        tokens=SimpleNamespace(single_use=SimpleNamespace(create=bad_token)),
        text_to_speech=SimpleNamespace(stream=bad_speech)))
    for path, body in [("token", {}), ("speech", {"text": "hello"})]:
        result = voice_client.post(f"/api/voice/{path}", headers=HEADERS, json=body)
        assert result.status_code == 502
        assert "private-test-key" not in result.text


def test_dashboard_connection_validates_and_uses_memory_without_env_write(voice_client, provider, monkeypatch, agent_dirs):
    import os
    from pathlib import Path
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    monkeypatch.delenv("ELEVENLABS_VOICE_ID")
    response = voice_client.post("/api/voice/configure", headers=HEADERS, json={"api_key": "private-test-key"})
    assert response.status_code == 200
    assert response.json()["voice_name"] == "Mission voice"
    assert response.headers["cache-control"] == "no-store"
    assert "private-test-key" not in response.text
    assert not Path(os.environ["ARK_ENV_PATH"]).exists()
    assert "ELEVENLABS_API_KEY" not in os.environ
    assert "private-test-key" not in repr(voice_client.app.state.voice_config)
    config = voice_client.get("/api/voice/config", headers=HEADERS).json()
    assert config["configured"] is True
    assert config["source"] == "dashboard"
    assert voice_client.post("/api/voice/token", json={}, headers=HEADERS).status_code == 200
    assert voice_client.post("/api/voice/speech", json={"text": "hello"}, headers=HEADERS).status_code == 200
    # A new backend instance must not inherit dashboard credentials.
    other = TestClient(create_app(planner_dir=agent_dirs["planner"]))
    assert other.get("/api/voice/config", headers=HEADERS).json()["configured"] is False


def test_dashboard_manual_voice_skips_list_permission(voice_client, provider, monkeypatch):
    import voice
    original = voice.AsyncElevenLabs
    def sdk(**kwargs):
        client = original(**kwargs)
        del client.voices
        return client
    monkeypatch.setattr(voice, "AsyncElevenLabs", sdk)
    result = voice_client.post("/api/voice/configure", headers=HEADERS, json={"api_key": "private-test-key", "voice_id": "account-voice"})
    assert result.status_code == 200
    assert result.json()["voice_id"] == "account-voice"


def test_failed_dashboard_replacement_preserves_working_connection(voice_client, provider, monkeypatch):
    import voice
    good = voice_client.post("/api/voice/configure", headers=HEADERS, json={"api_key": "private-test-key"})
    assert good.status_code == 200
    def fail(**kwargs):
        raise RuntimeError("secret-invalid-key")
    monkeypatch.setattr(voice, "AsyncElevenLabs", fail)
    bad = voice_client.post("/api/voice/configure", headers=HEADERS, json={"api_key": "secret-invalid-key"})
    assert bad.status_code == 502
    assert "secret-invalid-key" not in bad.text
    assert voice_client.app.state.voice_config.api_key == "private-test-key"


def test_dashboard_configure_requires_same_origin_guard(voice_client, provider):
    result = voice_client.post("/api/voice/configure", headers={"X-ARK-Voice": "1", "Origin": "https://attacker.example"}, json={"api_key": "private-test-key"})
    assert result.status_code == 403
    assert provider[0] == []
