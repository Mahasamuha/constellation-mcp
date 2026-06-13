-- Fix 1: Replace broken @@unique([userId, host]) with partial unique indexes.
-- The old constraint treats (NULL, host) as unique per row, so a shared agent
-- reconnecting with (NULL, "nas-1") can create duplicates. Replace with two
-- filtered indexes that handle personal and shared agents separately.
DROP INDEX IF EXISTS "agents_user_id_host_key";

-- Personal agents: (user_id, host) unique where user_id is not null
CREATE UNIQUE INDEX "agents_user_id_host_key"
  ON "agents" ("user_id", "host")
  WHERE "user_id" IS NOT NULL;

-- Shared agents: (agent_token_id, host) unique — token scopes the installation
CREATE UNIQUE INDEX "agents_token_id_host_key"
  ON "agents" ("agent_token_id", "host");

-- Fix 2: BrokerRole enum and User.role field
CREATE TYPE "BrokerRole" AS ENUM ('USER', 'ADMIN');
ALTER TABLE "users" ADD COLUMN "role" "BrokerRole" NOT NULL DEFAULT 'USER';

-- Fix 3: SharedPathLabel table — stores synced label registry from shared agents
-- for broker-side discovery (§4.1). permissionBlob is the full label permission
-- config as received from the agent; used for optimistic discovery filtering only.
CREATE TABLE "shared_path_labels" (
    "id"             TEXT      NOT NULL,
    "agent_id"       TEXT      NOT NULL,
    "label"          TEXT      NOT NULL,
    "reported_path"  TEXT      NOT NULL,
    "permission_blob" JSONB    NOT NULL,
    "updated_at"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_path_labels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shared_path_labels_agent_id_label_key"
  ON "shared_path_labels" ("agent_id", "label");

ALTER TABLE "shared_path_labels"
  ADD CONSTRAINT "shared_path_labels_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
