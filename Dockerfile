# syntax=docker/dockerfile:1.7
# =============================================================================
#  Multi-stage build.
#
#  Goals, in order: small final image, no build toolchain or source in the
#  runtime layer, non-root execution, and correct signal handling so SIGTERM
#  reaches Node and graceful shutdown actually runs.
# =============================================================================

ARG NODE_VERSION=22.14.0

# -----------------------------------------------------------------------------
#  deps — production dependencies only, cached independently of source changes
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

# Prisma engines need OpenSSL. argon2 needs a toolchain for its native addon.
RUN apk add --no-cache openssl libc6-compat python3 make g++

COPY package*.json ./
COPY prisma ./prisma

# Skip lifecycle scripts so the monorepo `prepare` (husky) does not run in the
# image. Explicitly rebuild argon2 so the native binding is present at runtime.
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild argon2 sharp \
    && npx prisma generate

# -----------------------------------------------------------------------------
#  build — full toolchain, compiled output
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
# Install all deps (incl. sharp/qrcode). Rebuild native addons after --ignore-scripts.
RUN npm ci --ignore-scripts \
    && npm rebuild sharp argon2

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build

# -----------------------------------------------------------------------------
#  runtime — minimal, non-root
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

# `dumb-init` becomes PID 1. Without it Node runs as PID 1, where the default
# SIGTERM handler is *not* installed — the container would be SIGKILLed after the
# grace period and in-flight requests and queue jobs would be dropped.
RUN apk add --no-cache openssl libc6-compat dumb-init font-dejavu fontconfig

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    # Keep the heap under the container memory limit so the OOM killer never
    # beats V8's own GC. Tune alongside the pod/task memory reservation.
    NODE_OPTIONS="--max-old-space-size=768"

# The node image already provides an unprivileged `node` user (uid 1000).
COPY --chown=node:node --from=deps  /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist         ./dist
COPY --chown=node:node prisma                          ./prisma
COPY --chown=node:node package.json                    ./
COPY --chown=node:node scripts/railway-start.sh        ./scripts/railway-start.sh

USER node

EXPOSE 3000

# Compose/Swarm use this; Kubernetes uses the readiness probe instead and should
# not duplicate it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "scripts/railway-start.sh"]
