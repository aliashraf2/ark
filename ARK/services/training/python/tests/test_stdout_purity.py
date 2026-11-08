"""stdout purity: EVERY line the bridge prints must be a protocol response.

stdout is the machine channel — a single banner, log line, or Rapier message
would desynchronize the client. This test drives a raw subprocess through a
full session (including malformed input) and parses each stdout line strictly.
"""

import json
import subprocess

from ark_gym.client import _default_bridge_path, _default_runner


def test_all_stdout_lines_are_protocol_responses():
    proc = subprocess.Popen(
        [_default_runner(), str(_default_bridge_path())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin and proc.stdout
    requests = [
        '{"protocolVersion":"1.0","requestId":"h","command":"hello"}',
        "this is not json",
        "",
        '{"protocolVersion":"9.9","requestId":"v","command":"hello"}',
        '{"protocolVersion":"1.0","requestId":"c","command":"create",'
        '"payload":{"planet":"earth","terrainSeed":1,"terrainSubdivisions":8}}',
        '{"protocolVersion":"1.0","requestId":"r","command":"reset",'
        '"envId":"env-1","payload":{"seed":2}}',
        '{"protocolVersion":"1.0","requestId":"s","command":"step",'
        '"envId":"env-1","payload":{"action":[0.25,-0.25]}}',
        '{"protocolVersion":"1.0","requestId":"g","command":"get_spaces"}',
        '{"protocolVersion":"1.0","requestId":"m","command":"get_metrics","envId":"env-1"}',
        '{"protocolVersion":"1.0","requestId":"x","command":"close","envId":"env-1"}',
        '{"protocolVersion":"1.0","requestId":"z","command":"shutdown"}',
    ]
    try:
        proc.stdin.write("\n".join(requests) + "\n")
        proc.stdin.flush()
        stdout, _stderr = proc.communicate(timeout=120)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == 0
    lines = [line for line in stdout.split("\n") if line.strip() != ""]
    # 11 requests minus the one blank line (ignored) = 10 responses.
    assert len(lines) == 10
    seen_ids = set()
    for line in lines:
        message = json.loads(line)  # raises on any non-JSON stdout pollution
        assert isinstance(message, dict)
        assert message["protocolVersion"] == "1.0"
        assert isinstance(message.get("ok"), bool)
        assert "requestId" in message
        if message["requestId"] is not None:
            seen_ids.add(message["requestId"])
        if message["ok"]:
            assert "result" in message
        else:
            assert set(message["error"]) >= {"code", "message"}
    assert seen_ids >= {"h", "c", "r", "s", "g", "m", "x", "z"}


def test_stderr_is_used_and_stdout_stays_clean_on_client_crash():
    """Killing stdin (parent death) shuts the server down without stdout garbage."""
    proc = subprocess.Popen(
        [_default_runner(), str(_default_bridge_path())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin and proc.stdout
    # communicate() writes the input, closes stdin (EOF), then reads to exit:
    # the server must answer hello and quit instead of idling forever.
    try:
        stdout, _ = proc.communicate(
            input='{"protocolVersion":"1.0","requestId":"h","command":"hello"}\n',
            timeout=60,
        )
    finally:
        if proc.poll() is None:
            proc.kill()
            raise AssertionError("Bridge did not exit on stdin EOF.")
    assert proc.returncode == 0
    lines = [line for line in stdout.split("\n") if line.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["ok"] is True
