# --- build stage ---
FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@latest

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/broker/src ./packages/broker/src
COPY packages/broker/tsconfig.json ./packages/broker/
COPY packages/broker/prisma ./packages/broker/prisma
COPY packages/broker/prisma.config.ts ./packages/broker/

RUN pnpm --filter @constellation/shared build
RUN pnpm --filter @constellation/broker exec prisma generate
RUN pnpm --filter @constellation/broker build

# --- runtime stage ---
FROM node:22-alpine
WORKDIR /app

RUN npm install -g pnpm@latest

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/broker/dist ./packages/broker/dist
COPY packages/broker/prisma ./packages/broker/prisma
COPY packages/broker/prisma.config.ts ./packages/broker/

COPY packages/broker/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
