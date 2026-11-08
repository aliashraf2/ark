FROM node:24-bookworm-slim AS web-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/simulator/package.json ./apps/simulator/package.json
COPY packages/physics/package.json ./packages/physics/package.json
COPY packages/rl/package.json ./packages/rl/package.json
RUN npm ci --no-audit --no-fund
COPY apps ./apps
COPY packages ./packages
COPY services/training ./services/training
RUN npm --workspace apps/simulator run build

FROM ghcr.io/astral-sh/uv:0.13.7 AS uv
FROM python:3.13-slim-bookworm AS agent
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_LINK_MODE=copy
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home ark
COPY --from=uv /uv /uvx /usr/local/bin/
WORKDIR /app/services/agent
COPY services/agent/pyproject.toml services/agent/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/agent ./
COPY packages/shared /app/packages/shared
RUN mkdir -p data && chown -R ark:ark data
USER ark
ENV PATH="/app/services/agent/.venv/bin:$PATH" ARK_ENV_PATH=/app/services/agent/data/agent.env ARK_AGENT_DATA=/app/services/agent/data
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-proxy-headers"]

FROM caddy:2.11.9-alpine AS gateway
COPY --from=web-build /src/apps/simulator/dist /srv
COPY deploy/vultr/Caddyfile /etc/caddy/Caddyfile
