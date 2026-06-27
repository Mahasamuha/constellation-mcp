-- Backfill missing code_challenge_method to the only value this app ever verifies
-- against before enforcing NOT NULL — oauth.ts already treats a missing method as
-- S256 at verification time (`entry.codeChallengeMethod ?? "S256"`), so this just
-- makes that existing assumption explicit in stored rows instead of read-time.
UPDATE "auth_codes" SET "code_challenge_method" = 'S256' WHERE "code_challenge_method" IS NULL;

-- Remove any auth code lacking a PKCE challenge entirely before enforcing NOT NULL.
-- Every current code path (issueAuthCode) already requires /oauth/authorize's
-- code_challenge before creating a row, so a null here is a pre-existing anomaly,
-- not legitimate state — and these rows are short-lived (10 min TTL), so deleting
-- one just forces an in-flight login to restart from /oauth/authorize.
DELETE FROM "auth_codes" WHERE "code_challenge" IS NULL;

ALTER TABLE "auth_codes" ALTER COLUMN "code_challenge" SET NOT NULL;
ALTER TABLE "auth_codes" ALTER COLUMN "code_challenge_method" SET NOT NULL;
ALTER TABLE "auth_codes" ALTER COLUMN "code_challenge_method" SET DEFAULT 'S256';
