-- Device codes are bearer credentials for the device-authorization flow (RFC 8628)
-- and must be hashed at rest like every other token type in this schema
-- (auth_codes.code_hash, executor_tokens.token_hash). Existing rows have a
-- 15-minute TTL and are pruned automatically, so no backfill is needed.
ALTER TABLE "device_codes" RENAME COLUMN "device_code" TO "device_code_hash";
