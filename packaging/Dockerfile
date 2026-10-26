# SKELETON: the image holds only the router. Built, started as a non-root user, served over a Unix socket and stopped cleanly with SIGTERM on 2026-10-25 (Docker 29.9, and in CI). Add your upstream MCP server (and its credentials via a volume) before it can serve anything.
# Build from the repo root: docker build -f packaging/Dockerfile .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY router.mjs ./
COPY lib ./lib
# The router binds ::1 only, so a published TCP port is unreachable from the host.
# Configure a Unix socket ("socket": "/run/acctmux/acctmux.sock", "tcp": false) and mount /run/acctmux.
USER node
ENTRYPOINT ["node", "router.mjs"]
