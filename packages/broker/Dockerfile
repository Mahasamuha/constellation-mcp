# --- build stage ---
FROM node:24-alpine AS builder
WORKDIR /app

# Required to compile native addons (re2) from source on Alpine (musl libc)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/
COPY packages/telescope/package.json ./packages/telescope/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/broker/src ./packages/broker/src
COPY packages/broker/tsconfig.json ./packages/broker/
COPY packages/broker/prisma ./packages/broker/prisma
COPY packages/broker/prisma.config.ts ./packages/broker/
COPY packages/telescope/src ./packages/telescope/src
COPY packages/telescope/index.html packages/telescope/vite.config.ts packages/telescope/tsconfig.json ./packages/telescope/

RUN npm run build -w packages/shared
RUN npm exec -w packages/broker -- prisma generate
RUN npm run build -w packages/broker
# Produces packages/telescope/dist/app.html — the bundled MCP Apps UI resource
RUN npm run build -w packages/telescope

# Strip dev dependencies in place so the runtime stage can copy node_modules
# directly without needing build tools installed there.
RUN npm prune --omit=dev

# --- runtime stage ---
FROM node:24-alpine
WORKDIR /app

# Remove BusyBox's wget (CVE-2025-60876, CRLF/header injection in the request
# target — no upstream fix yet). It's just a symlink to the busybox multi-call
# binary and nothing in the broker uses it, so dropping it clears the scan finding.
RUN rm -f /usr/bin/wget

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/

# Copy pruned node_modules from builder — includes compiled native addons (re2)
COPY --from=builder /app/node_modules ./node_modules
# Copy workspace-nested node_modules (packages npm didn't hoist to root)
COPY --from=builder /app/packages/broker/node_modules ./packages/broker/node_modules

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/broker/dist ./packages/broker/dist
# Bundled file browser UI — read from disk by mcp.ts via ../ui/app.html relative to dist/
COPY --from=builder /app/packages/telescope/dist/app.html ./packages/broker/ui/app.html
COPY packages/broker/prisma ./packages/broker/prisma
COPY packages/broker/prisma.config.ts ./packages/broker/

COPY packages/broker/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app

USER node

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
