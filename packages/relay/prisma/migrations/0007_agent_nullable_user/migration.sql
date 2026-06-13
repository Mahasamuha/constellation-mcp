-- AlterTable: make user_id nullable on agents to support shared agents with no owner
ALTER TABLE "agents" ALTER COLUMN "user_id" DROP NOT NULL;

-- Add partial unique index for shared agents: enforces one agent per host when user_id IS NULL.
-- The existing @@unique([userId, host]) covers personal agents; PostgreSQL treats NULLs as
-- distinct in unique constraints so a separate partial index is required for shared agents.
CREATE UNIQUE INDEX "agents_shared_host_key" ON "agents"("host") WHERE "user_id" IS NULL;
