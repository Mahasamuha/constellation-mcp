-- "Agent" (the connected node/hub installation record) is renamed to "Executor",
-- for consistency with ExecutorToken — an ExecutorToken authenticates an Executor.

-- Rename agent_connect/agent_disconnect -> executor_connect/executor_disconnect.
ALTER TYPE "ActivityEventType" RENAME VALUE 'agent_connect' TO 'executor_connect';
ALTER TYPE "ActivityEventType" RENAME VALUE 'agent_disconnect' TO 'executor_disconnect';

-- Rename agents -> executors, and its constraints/indexes.
ALTER TABLE "agents" RENAME TO "executors";
ALTER TABLE "executors" RENAME CONSTRAINT "agents_pkey" TO "executors_pkey";
ALTER TABLE "executors" RENAME CONSTRAINT "agents_user_id_fkey" TO "executors_user_id_fkey";
ALTER TABLE "executors" RENAME CONSTRAINT "agents_executor_token_id_fkey" TO "executors_executor_token_id_fkey";
ALTER INDEX "agents_user_id_host_key" RENAME TO "executors_user_id_host_key";
ALTER INDEX "agents_executor_token_id_host_key" RENAME TO "executors_executor_token_id_host_key";

-- Rename path_labels.agent_id -> executor_id, and its constraint.
ALTER TABLE "path_labels" RENAME COLUMN "agent_id" TO "executor_id";
ALTER TABLE "path_labels" RENAME CONSTRAINT "path_labels_agent_id_fkey" TO "path_labels_executor_id_fkey";

-- Rename broker_path_filters.scope_agent_id -> scope_executor_id, and its constraint.
ALTER TABLE "broker_path_filters" RENAME COLUMN "scope_agent_id" TO "scope_executor_id";
ALTER TABLE "broker_path_filters" RENAME CONSTRAINT "broker_path_filters_scope_agent_id_fkey" TO "broker_path_filters_scope_executor_id_fkey";

-- Rename shared_path_labels.agent_id -> executor_id, and its constraint/index.
ALTER TABLE "shared_path_labels" RENAME COLUMN "agent_id" TO "executor_id";
ALTER TABLE "shared_path_labels" RENAME CONSTRAINT "shared_path_labels_agent_id_fkey" TO "shared_path_labels_executor_id_fkey";
ALTER INDEX "shared_path_labels_agent_id_label_key" RENAME TO "shared_path_labels_executor_id_label_key";
