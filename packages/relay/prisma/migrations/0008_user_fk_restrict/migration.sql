-- A deleted user must not turn their nodes into user-less (hub-like) rows, which the hub paths
-- treat as owner-less hubs. Refuse the delete instead; remove the user's executors and tokens first.
ALTER TABLE "executor_tokens" DROP CONSTRAINT "executor_tokens_user_id_fkey";
ALTER TABLE "executor_tokens" ADD CONSTRAINT "executor_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "executors" DROP CONSTRAINT "executors_user_id_fkey";
ALTER TABLE "executors" ADD CONSTRAINT "executors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
