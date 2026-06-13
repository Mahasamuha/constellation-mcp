CREATE TYPE "DisconnectReason" AS ENUM ('clean', 'timeout', 'error');

ALTER TABLE "agents" ADD COLUMN "last_disconnect_reason" "DisconnectReason";
