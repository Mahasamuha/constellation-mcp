-- AlterTable: store OIDC claims from last login for forwarding in RPC envelopes
ALTER TABLE "users" ADD COLUMN "last_known_claims" JSONB;
