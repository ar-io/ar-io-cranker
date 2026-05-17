# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for AR.IO epoch cranker.
#
# The image consumes @ar-io/sdk from GitHub Packages and needs an auth
# token at build time. Pass it as a BuildKit secret so it never lands
# in a layer. Two equivalent ways:
#
#   # Pass via env var (recommended in CI):
#   echo "$NODE_AUTH_TOKEN" | docker buildx build \
#     --secret id=node_auth_token,src=/dev/stdin \
#     -t ar-io-cranker .
#
#   # Or pass via a file:
#   docker buildx build \
#     --secret id=node_auth_token,src=/path/to/token.txt \
#     -t ar-io-cranker .
#
# In GitHub Actions: pass `secrets: node_auth_token=${{ secrets.GITHUB_TOKEN }}`
# to docker/build-push-action.

# ---------- builder ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /build

COPY package.json package-lock.json ./

# Write a fully-substituted .npmrc for the install, then delete it so the
# auth token never lands in a layer.

# Install ALL deps (including dev) to build TypeScript.
RUN --mount=type=secret,id=node_auth_token \
    TOKEN=$(cat /run/secrets/node_auth_token) && \
    printf '@ar-io:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" > .npmrc && \
    npm ci --no-audit --no-fund && \
    rm -f .npmrc

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-install omitting dev dependencies for the runtime stage.
RUN --mount=type=secret,id=node_auth_token \
    TOKEN=$(cat /run/secrets/node_auth_token) && \
    printf '@ar-io:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" > .npmrc && \
    rm -rf node_modules && \
    npm ci --no-audit --no-fund --omit=dev --ignore-scripts && \
    rm -f .npmrc

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# tini = PID 1 (forwards SIGTERM to Node so graceful shutdown fires).
# curl = used by HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Non-root user (uid 10001).
RUN groupadd --system --gid 10001 cranker \
 && useradd --system --uid 10001 --gid cranker --home /app --shell /usr/sbin/nologin cranker

COPY --from=builder --chown=cranker:cranker /build/node_modules ./node_modules
COPY --from=builder --chown=cranker:cranker /build/dist ./dist
COPY --from=builder --chown=cranker:cranker /build/package.json ./

USER cranker

# Inside a container, bind to all interfaces so the health endpoint is
# reachable on the published port. Operators should still publish only
# to localhost externally (e.g. -p 127.0.0.1:8080:8080).
ENV HEALTH_HOST=0.0.0.0
ENV HEALTH_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:${HEALTH_PORT:-8080}/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/index.js"]
CMD []

LABEL org.opencontainers.image.source="https://github.com/ar-io/ar-io-cranker"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.description="AR.IO Network epoch cranker"
