-- Hub executors have no owner, so (user_id, host) uniqueness does not cover them and two
-- concurrent registrations of one host could both insert. One user-less executor per host.
-- Fails if a deployment already has two user-less executors with the same host; remove the
-- stale row (and its token) first.
CREATE UNIQUE INDEX "executors_hub_host_key" ON "executors"("host") WHERE "user_id" IS NULL;
