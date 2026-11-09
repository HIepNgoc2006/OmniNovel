# ==========================================
# STAGE 1: Monorepo Workspace Builder
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/

RUN npm ci --workspace=@omninovel/shared --workspace=@omninovel/api --include-workspace-root

COPY packages/shared ./packages/shared
COPY services/api ./services/api

RUN npm run build --workspace=@omninovel/shared
RUN npm run build --workspace=@omninovel/api

RUN npm prune --omit=dev --workspace=@omninovel/shared --workspace=@omninovel/api

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000

# Security Hardening: Upgrade Alpine base OS packages and remove unused global npm/npx from production runtime
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

COPY --from=builder /app/services/api/dist ./services/api/dist
COPY --from=builder /app/services/api/package.json ./services/api/package.json

WORKDIR /app/services/api

USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8000/health/live || exit 1

EXPOSE 8000

CMD ["node", "dist/main"]
