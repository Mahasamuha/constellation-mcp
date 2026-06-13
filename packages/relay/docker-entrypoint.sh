#!/bin/sh
set -e

echo "Applying pending migrations..."
npm exec -w packages/relay -- prisma migrate deploy

echo "Starting relay..."
exec node packages/relay/dist/index.js
