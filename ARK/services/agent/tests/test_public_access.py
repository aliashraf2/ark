import pytest
from fastapi.testclient import TestClient

from app import create_app
from public_access import public_settings

ORIGIN = "https://ark.example.com"
TOKEN = "a" * 64


@pytest.fixture
def public_client(agent_dirs, monkeypatch):
    monkeypatch.setenv("ARK_PUBLIC_ORIGIN", ORIGIN)
    monkeypatch.setenv("ARK_PROXY_TOKEN", TOKEN)
    monkeypatch.setenv("ARK_CORS_ORIGINS", ORIGIN)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_VOICE_ID", raising=False)
    return TestClient(create_app(planner_dir=agent_dirs["planner"]), base_url=ORIGIN)


def test_public_backend_rejects_direct_access_even_with_correct_origin(public_client):
    result = public_client.get("/api/health", headers={"Origin": ORIGIN})
    assert result.status_code == 401
    assert TOKEN not in result.text


def test_authenticated_gateway_allows_health_and_dashboard_voice(public_client):
    headers = {"X-ARK-Proxy-Token": TOKEN, "X-ARK-Voice": "1", "Origin": ORIGIN}
    assert public_client.get("/api/health", headers=headers).status_code == 200
    # Public Host now works; missing provider config is reported normally.
    assert public_client.get("/api/voice/config", headers=headers).status_code == 200
    assert public_client.post("/api/voice/token", headers=headers, json={}).status_code == 503


@pytest.mark.parametrize("headers", [
    {"Origin": "https://attacker.example"},
    {"Origin": "null"},
    {},
    {"Origin": ORIGIN, "Host": "attacker.example"},
])
def test_mutations_require_exact_origin_and_host(public_client, headers):
    response = public_client.post("/api/mission/configure", headers={"X-ARK-Proxy-Token": TOKEN, **headers},
                                  json={"provider": "gemini", "api_key": "not-a-real-key"})
    assert response.status_code == 403


def test_internal_health_check_still_requires_proxy_token(public_client):
    assert public_client.get("http://127.0.0.1:8000/api/health").status_code == 401
    assert public_client.get("http://127.0.0.1:8000/api/health", headers={"X-ARK-Proxy-Token": TOKEN}).status_code == 200


def test_public_api_respects_normal_validation_after_authorization(public_client):
    result = public_client.post("/api/mission/interpret", headers={"X-ARK-Proxy-Token": TOKEN, "Origin": ORIGIN}, json={})
    assert result.status_code == 422


@pytest.mark.parametrize("origin,token", [("http://ark.example.com", TOKEN), (ORIGIN + "/path", TOKEN),
                                         ("https://user:pass@ark.example.com", TOKEN), (ORIGIN, "short")])
def test_public_mode_fails_closed_on_bad_configuration(monkeypatch, origin, token):
    monkeypatch.setenv("ARK_PUBLIC_ORIGIN", origin)
    monkeypatch.setenv("ARK_PROXY_TOKEN", token)
    with pytest.raises(ValueError):
        public_settings()
