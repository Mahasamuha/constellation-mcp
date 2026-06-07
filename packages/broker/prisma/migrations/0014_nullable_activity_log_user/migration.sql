-- AlterTable: make user_id nullable on activity_logs to support events with no
-- associated user — e.g. connect/disconnect for shared agents, which aren't
-- bound to any single user. Such rows are readable only by admins.
ALTER TABLE "activity_logs" ALTER COLUMN "user_id" DROP NOT NULL;
