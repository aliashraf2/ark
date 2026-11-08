"""Persistent subprocess client for the ARK RL bridge server.

One BridgeClient owns one Node.js process for its whole lifetime: requests are
sent as single JSON lines on stdin and responses read as single JSON lines on
stdout. Calls are strictly sequential (one outstanding request), guarded by a
lock so concurrent threads cannot interleave requests.
"""

from __future__ import annotations

import itertools
import json
import os
import select
import shutil
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import Any

from .exceptions import (
    ArkBridgeError,
    ArkEnvError,
    ArkEnvLimitError,
    ArkEpisodeError,
    ArkProtocolError,
    ArkUnknownEnvError,
    ArkValidationError,
    BridgeCrashedError,
    BridgeTimeoutError,
)

PROTOCOL_VERSION = "1.0"

_ERROR_TYPES: dict[str, type[ArkBridgeError]] = {
    "bad_request": ArkProtocolError,
    "unknown_command": ArkProtocolError,
    "version_mismatch": ArkProtocolError,
    "unknown_env": ArkUnknownEnvError,
    "env_limit": ArkEnvLimitError,
    "validation_error": ArkValidationError,
    "step_before_reset": ArkEpisodeError,
    "step_after_done": ArkEpisodeError,
    "env_error": ArkEnvError,
    "internal": ArkBridgeError,
}


def _repo_root() -> Path:
    """Locate the ARK repo root: $ARK_REPO_ROOT, else derived from package path.

    Installed layout is <root>/services/training/python/src/ark_gym, so the
    root is four parents up from this file. Raises a clear error when neither
    resolves to a checkout containing the bridge server.
    """
    override = os.environ.get("ARK_REPO_ROOT")
    if override:
        return Path(override)
    candidate = Path(__file__).resolve().parents[5]
    if (candidate / "services" / "training" / "bridge" / "server.ts").is_file():
        return candidate
    raise ArkBridgeError(
        "Cannot locate the ARK repo root (bridge server not found). Set $ARK_REPO_ROOT."
    )


def _default_bridge_path() -> Path:
    override = os.environ.get("ARK_BRIDGE_PATH")
    if override:
        return Path(override)
    return _repo_root() / "services" / "training" / "bridge" / "server.ts"


def _default_runner() -> str:
    override = os.environ.get("ARK_BRIDGE_RUNNER")
    if override:
        return override
    local_tsx = _repo_root() / "node_modules" / ".bin" / "tsx"
    if local_tsx.is_file():
        return str(local_tsx)
    found = shutil.which("tsx")
    if found:
        return found
    raise ArkBridgeError(
        "Cannot find tsx: no repo-local node_modules/.bin/tsx and none on PATH. "
        "Run `npm install` at the repo root, or set $ARK_BRIDGE_RUNNER."
    )


class BridgeClient:
    """Synchronous JSONL client over a persistent Node.js bridge process."""

    def __init__(
        self,
        bridge_path: str | Path | None = None,
        runner: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._bridge_path = Path(bridge_path) if bridge_path else _default_bridge_path()
        self._runner = runner or _default_runner()
        self._timeout = timeout
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._stderr_tail: deque[str] = deque(maxlen=50)
        self._closed = False
        if not self._bridge_path.is_file():
            raise ArkBridgeError(f"Bridge server not found: {self._bridge_path}")
        try:
            self._proc = subprocess.Popen(
                [self._runner, str(self._bridge_path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            raise BridgeCrashedError(f"Failed to launch bridge: {exc}") from exc
        assert self._proc.stdin and self._proc.stdout and self._proc.stderr
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()
        # Fail fast on version skew or a dead-on-arrival process.
        hello = self.hello()
        if hello.get("protocolVersion") != PROTOCOL_VERSION:
            self.close()
            raise ArkProtocolError(
                f"Bridge protocol {hello.get('protocolVersion')!r} != client {PROTOCOL_VERSION!r}."
            )

    # -- low-level transport ------------------------------------------------

    def _drain_stderr(self) -> None:
        try:
            assert self._proc.stderr
            for line in self._proc.stderr:
                self._stderr_tail.append(line.rstrip("\n"))
        except (ValueError, OSError):
            pass  # Pipe closed during shutdown.

    def _readline(self) -> str:
        assert self._proc.stdout
        stream = self._proc.stdout
        ready, _, _ = select.select([stream], [], [], self._timeout)
        if not ready:
            raise BridgeTimeoutError(
                f"No bridge response within {self._timeout}s. stderr tail: {list(self._stderr_tail)}"
            )
        line = stream.readline()
        if line == "":
            raise BridgeCrashedError(
                "Bridge stdout closed unexpectedly. "
                f"exit={self._proc.poll()} stderr tail: {list(self._stderr_tail)}"
            )
        return line

    def _request(
        self, command: str, env_id: str | None = None, payload: Any = None
    ) -> Any:
        with self._lock:
            if self._closed:
                raise BridgeCrashedError("BridgeClient is closed.")
            if self._proc.poll() is not None:
                raise BridgeCrashedError(
                    f"Bridge process exited with code {self._proc.returncode}. "
                    f"stderr tail: {list(self._stderr_tail)}"
                )
            request_id = f"py-{os.getpid()}-{next(self._ids)}"
            message: dict[str, Any] = {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "command": command,
            }
            if env_id is not None:
                message["envId"] = env_id
            if payload is not None:
                message["payload"] = payload
            assert self._proc.stdin
            try:
                # allow_nan=False: never emit bare NaN/Infinity tokens, which
                # are not valid JSON and would corrupt the stream contract.
                encoded = json.dumps(message, allow_nan=False) + "\n"
            except ValueError as exc:
                raise ArkValidationError(
                    f"Request payload is not JSON-serializable (non-finite?): {exc}"
                ) from exc
            try:
                self._proc.stdin.write(encoded)
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise BridgeCrashedError(
                    f"Bridge stdin write failed: {exc}. stderr tail: {list(self._stderr_tail)}"
                ) from exc
            raw = self._readline()
            try:
                response = json.loads(raw)
            except json.JSONDecodeError as exc:
                # Never skip a corrupt line: it desynchronizes the whole stream.
                raise ArkProtocolError(
                    f"Bridge stdout line is not valid JSON: {raw[:200]!r} ({exc})"
                ) from exc
            if not isinstance(response, dict) or response.get("requestId") != request_id:
                raise ArkProtocolError(f"Bridge response id mismatch: {raw[:200]!r}")
            if response.get("ok") is True:
                return response.get("result")
            error = response.get("error") or {}
            code = error.get("code", "internal")
            exc_type = _ERROR_TYPES.get(code, ArkBridgeError)
            raise exc_type(f"[{code}] {error.get('message', 'Unknown bridge error.')}")

    # -- protocol commands --------------------------------------------------

    def hello(self) -> dict[str, Any]:
        return self._request("hello")

    def create(self, config: dict[str, Any]) -> str:
        result = self._request("create", payload=config)
        return result["envId"]

    def reset(
        self,
        env_id: str,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if seed is not None:
            payload["seed"] = seed
        if options is not None:
            payload["options"] = options
        return self._request("reset", env_id, payload)

    def step(self, env_id: str, action: list[float]) -> dict[str, Any]:
        return self._request("step", env_id, {"action": action})

    def get_spaces(self) -> dict[str, Any]:
        return self._request("get_spaces")

    def get_metrics(self, env_id: str) -> dict[str, Any]:
        return self._request("get_metrics", env_id)

    def close_env(self, env_id: str) -> None:
        self._request("close", env_id)

    # -- lifecycle ------------------------------------------------------------

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            if self._proc.poll() is None:
                assert self._proc.stdin
                try:
                    self._proc.stdin.write(
                        json.dumps(
                            {
                                "protocolVersion": PROTOCOL_VERSION,
                                "requestId": f"py-{os.getpid()}-shutdown",
                                "command": "shutdown",
                            }
                        )
                        + "\n"
                    )
                    self._proc.stdin.flush()
                    self._proc.wait(timeout=10)
                except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                    pass
            if self._proc.poll() is None:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
        finally:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            self._stderr_thread.join(timeout=5)

    def __enter__(self) -> BridgeClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def __del__(self) -> None:  # best effort; close() is idempotent
        try:
            self.close()
        except Exception:
            pass
