-- Hub executors have no owner, so (user_id, host) uniqueness does not cover them and two
-- concurrent registrations of one host could both insert. One user-less executor per host.
--
-- Before the index can exist, deduplicate. For each host with several user-less executors keep
-- the one whose token is a live HUB token (not revoked); if none is live, keep the most recently
-- registered. The others are removed with their path shares, hub shares and path filters (the FK
-- chain), and their tokens are revoked. Two live HUB rows on one host cannot be told apart, so
-- the migration aborts and the operator must revoke one first.
DO $$
DECLARE
  h text;
  keeper text;
  live_count int;
  dropped text[];
BEGIN
  FOR h IN
    SELECT "host" FROM "executors" WHERE "user_id" IS NULL GROUP BY "host" HAVING count(*) > 1
  LOOP
    SELECT count(*) INTO live_count
      FROM "executors" e JOIN "executor_tokens" t ON t."id" = e."executor_token_id"
      WHERE e."user_id" IS NULL AND e."host" = h AND t."token_type" = 'HUB' AND t."revoked_at" IS NULL;

    IF live_count > 1 THEN
      RAISE EXCEPTION 'migration 0007: host "%" has % user-less executors with live HUB tokens; revoke or delete all but one, then re-run', h, live_count;
    END IF;

    SELECT e."id" INTO keeper
      FROM "executors" e JOIN "executor_tokens" t ON t."id" = e."executor_token_id"
      WHERE e."user_id" IS NULL AND e."host" = h
      ORDER BY (t."token_type" = 'HUB' AND t."revoked_at" IS NULL) DESC, e."registered_at" DESC, e."id" DESC
      LIMIT 1;

    SELECT array_agg(e."id") INTO dropped
      FROM "executors" e WHERE e."user_id" IS NULL AND e."host" = h AND e."id" <> keeper;

    DELETE FROM "path_shares" WHERE "executor_id" = ANY(dropped);
    DELETE FROM "hub_shares" WHERE "executor_id" = ANY(dropped);
    DELETE FROM "relay_path_filters" WHERE "scope_executor_id" = ANY(dropped);

    UPDATE "executor_tokens" SET "revoked_at" = now()
      WHERE "revoked_at" IS NULL
        AND "id" IN (SELECT "executor_token_id" FROM "executors" WHERE "id" = ANY(dropped));

    DELETE FROM "executors" WHERE "id" = ANY(dropped);
  END LOOP;
END $$;

CREATE UNIQUE INDEX "executors_hub_host_key" ON "executors"("host") WHERE "user_id" IS NULL;
