# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# Embedder sidecar.
#
# Builds from the repo root: docker build -f apps/embedder/Dockerfile .
# -----------------------------------------------------------------------------

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/embedder/package.json ./apps/embedder/
# Other workspace package.json files needed so pnpm install can resolve the
# workspace before --filter narrows things down.
COPY apps/web/package.json ./apps/web/
COPY packages/schemas/package.json ./packages/schemas/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @shared-memory/embedder...

# ---------- builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/embedder/node_modules ./apps/embedder/node_modules
COPY . .

# Compile TS to JS.
RUN cd apps/embedder \
 && pnpm exec tsc -p tsconfig.json --noEmit false --outDir dist

# Prune devDependencies so the runtime image only ships production deps.
RUN cd apps/embedder \
 && pnpm install --prod --frozen-lockfile --filter @shared-memory/embedder...

# ---------- runner ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    MODEL_CACHE_DIR=/data/models

RUN apk add --no-cache wget \
 && addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs node-embedder \
 && mkdir -p /data/models \
 && chown -R node-embedder:nodejs /data

COPY --from=builder --chown=node-embedder:nodejs /app/apps/embedder/dist            ./dist
COPY --from=builder --chown=node-embedder:nodejs /app/apps/embedder/node_modules    ./node_modules
COPY --from=builder --chown=node-embedder:nodejs /app/apps/embedder/package.json    ./package.json

USER node-embedder
EXPOSE 8080
VOLUME ["/data/models"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD wget -q -O - http://127.0.0.1:8080/health | grep -q '"ready":true' || exit 1

CMD ["node", "--enable-source-maps", "dist/index.js"]
