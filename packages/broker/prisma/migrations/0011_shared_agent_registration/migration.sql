-- Phase 2.6: Shared agent registration
-- approved_by_user_id on agent_tokens: set when a SHARED token is created via the
-- device code registration flow, recording which admin approved the registration.
ALTER TABLE "agent_tokens" ADD COLUMN "approved_by_user_id" TEXT;
