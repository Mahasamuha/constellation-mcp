-- Phase 2.5: Role model and session-level elevation
-- admin_until on oauth_sessions: null = not elevated; set to a future timestamp
-- by the approval handler when the approving user has role ADMIN.
ALTER TABLE "oauth_sessions" ADD COLUMN "admin_until" TIMESTAMP(3);

-- elevate_session_id on device_codes: set when the device code is initiated for
-- step-up escalation (scope = agent:escalate). null for all other flows.
ALTER TABLE "device_codes" ADD COLUMN "elevate_session_id" TEXT;
