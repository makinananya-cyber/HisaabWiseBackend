# Multi-stage, so the runtime image carries no compiler and no dev dependencies.
#
# UNVERIFIED: there is no container runtime on the development machine this was written on, so
# this file has not been built. Build it once before relying on it — the likely friction is
# `argon2`, a native addon that needs a toolchain in the dependency stage.
#
# The image takes all configuration from the environment (see .env.example) and needs no build
# arguments. That is what keeps the hosting decision late and reversible: the same image runs on
# Cloudflare Containers, Render, Railway, Fly, or a plain VPS.

# ── Production dependencies, with a toolchain for the native addon ─────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Build the bundle ──────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./
# Editorial content is read from disk at startup and versioned with the deploy (ADR-0008). The
# directory arrives with slice 1; copying it now would fail the build.
# COPY content ./content

# Never root.
USER node

EXPOSE 8080

# The shallow endpoint on purpose: it does no database work, so an orchestrator polling it every
# few seconds does not spend an Atlas connection per probe (ADR-0013).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Direct exec, no init shell: the server installs SIGTERM and SIGINT handlers itself and needs to
# receive them as PID 1 to drain in-flight requests and release the pool.
CMD ["node", "dist/server.js"]
