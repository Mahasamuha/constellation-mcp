# --- build stage ---
FROM node:22-alpine AS builder
WORKDIR /app

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

# --- runtime stage ---
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/
RUN npm ci --omit=dev

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/broker/dist ./packages/broker/dist
COPY packages/broker/prisma ./packages/broker/prisma
COPY packages/broker/prisma.config.ts ./packages/broker/

COPY packages/broker/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
