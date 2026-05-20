#!/bin/sh
set -e

echo "Applying pending migrations..."
cd packages/broker
pnpm exec prisma migrate deploy
cd /app

echo "Starting broker..."
exec node packages/broker/dist/index.js
