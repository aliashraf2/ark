"""Public deployments trust only the authenticated, same-origin HTTPS gateway."""
from __future__ import annotations

import hmac
import os
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse


def public_settings() -> tuple[str, str]:
    origin = os.getenv("ARK_PUBLIC_ORIGIN", "").strip().rstrip("/")
    token = os.getenv("ARK_PROXY_TOKEN", "")
    if not origin:
        return "", ""
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("ARK_PUBLIC_ORIGIN must be one HTTPS origin, without a path or credentials.")
    if len(token) < 32 or not token.isascii():
        raise ValueError("Public deployment requires an ARK_PROXY_TOKEN of at least 32 ASCII characters.")
    return origin, token


class PublicAccessMiddleware:
    """Caddy authenticates the user and replaces the private proxy header.

    The backend is not published on a host port. This additional guard prevents
    accidental proxy bypass; it is deliberately independent of CORS. Pure ASGI
    preserves streaming/cancellation without buffering speech responses.
    """

    def __init__(self, app, origin: str, token: str):
        self.app = app
        self.origin = origin
        self.host = urlsplit(origin).netloc
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        supplied = request.headers.get("x-ark-proxy-token", "")
        status, detail = 0, ""
        if not hmac.compare_digest(supplied.encode(), self.token.encode()):
            status, detail = 401, "Use the authenticated ARK HTTPS dashboard."
        elif request.headers.get("host") != self.host and not (
            request.url.path == "/api/health" and request.url.hostname in {"127.0.0.1", "localhost"}
        ):
            status, detail = 403, "Unexpected dashboard host."
        elif request.headers.get("origin") and request.headers["origin"] != self.origin:
            status, detail = 403, "Dashboard origin is not allowed."
        elif request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("origin") != self.origin:
            status, detail = 403, "Dashboard origin is required."
        if status:
            return await JSONResponse({"detail": detail}, status_code=status, headers={"Cache-Control": "no-store"})(scope, receive, send)
        await self.app(scope, receive, send)
