# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# Multi-stage build for @shared-memory/web.
#
#   deps     — pnpm install with workspace context
#   builder  — next build (standalone) + bundled migrator
#   runner   — minimal Node runtime, non-root, runs server.js
#
# Build from the repo root:
#   docker build -t shared-memory-web -f apps/web/Dockerfile .
# -----------------------------------------------------------------------------

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/
COPY packages/schemas/package.json ./packages/schemas/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/schemas/node_modules ./packages/schemas/node_modules
COPY . .

# Build the Next.js standalone bundle. Env validation is bypassed here so
# the image can be built without real OIDC/DB secrets baked in; runtime
# validation in `env.ts` re-checks all vars on first request.
ENV SKIP_ENV_VALIDATION=true \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @shared-memory/web build

# Bundle the migrator into a single ESM file so the runtime image doesn't
# need tsx or the rest of devDependencies.
RUN pnpm --filter @shared-memory/web exec esbuild apps/web/scripts/migrate.ts \
    --bundle --platform=node --target=node20 --format=esm \
    --outfile=apps/web/migrate.mjs

# ---------- runner ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# `wget` is alpine's tiny default; used by the docker healthcheck.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

# Standalone bundle includes traced node_modules + server.js.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/drizzle ./apps/web/drizzle
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/migrate.mjs ./apps/web/migrate.mjs

USER nextjs
EXPOSE 3000

# Default command runs the server. The compose `migrator` service overrides
# this to run migrations once before the app comes up.
CMD ["node", "apps/web/server.js"]
