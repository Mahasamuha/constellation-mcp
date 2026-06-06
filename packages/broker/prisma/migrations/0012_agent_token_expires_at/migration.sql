-- Agent token expiry: used by rotation tokens to survive a broker restart.
-- revokeOrphanedTokens() now only revokes orphaned tokens past their expiresAt,
-- leaving fresh rotation tokens intact so agents can complete rotation after restart.
ALTER TABLE "agent_tokens" ADD COLUMN "expires_at" TIMESTAMP(3);
