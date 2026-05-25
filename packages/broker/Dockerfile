# --- build stage ---
FROM node:24-alpine AS builder
WORKDIR /app

# Required to compile native addons (re2) from source on Alpine (musl libc)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/broker/src ./packages/broker/src
COPY packages/broker/tsconfig.json ./packages/broker/
COPY packages/broker/prisma ./packages/broker/prisma
COPY packages/broker/prisma.config.ts ./packages/broker/

RUN npm run build -w packages/shared
RUN npm exec -w packages/broker -- prisma generate
RUN npm run build -w packages/broker

# Strip dev dependencies in place so the runtime stage can copy node_modules
# directly without needing build tools installed there.
RUN npm prune --omit=dev

# --- runtime stage ---
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/

# Copy pruned node_modules from builder — includes compiled native addons (re2)
COPY --from=builder /app/node_modules ./node_modules
# Copy workspace-nested node_modules (packages npm didn't hoist to root)
COPY --from=builder /app/packages/broker/node_modules ./packages/broker/node_modules

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/broker/dist ./packages/broker/dist
COPY packages/broker/prisma ./packages/broker/prisma
COPY packages/broker/prisma.config.ts ./packages/broker/

COPY packages/broker/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
