#!/bin/sh
set -e

echo "Applying pending migrations..."
npm exec -w packages/broker -- prisma migrate deploy

echo "Starting broker..."
exec node packages/broker/dist/index.js
