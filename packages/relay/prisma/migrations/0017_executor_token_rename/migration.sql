-- Rename AgentTokenType -> ExecutorTokenType, with values PERSONAL -> NODE, SHARED -> HUB.
-- "Agent" now refers to a connected node/hub installation; the token type discriminator
-- is renamed to "executor" to avoid colliding with that vocabulary.
ALTER TYPE "AgentTokenType" RENAME TO "ExecutorTokenType";
ALTER TYPE "ExecutorTokenType" RENAME VALUE 'PERSONAL' TO 'NODE';
ALTER TYPE "ExecutorTokenType" RENAME VALUE 'SHARED' TO 'HUB';

-- Rename agent_tokens -> executor_tokens, and its constraints/indexes.
ALTER TABLE "agent_tokens" RENAME TO "executor_tokens";
ALTER TABLE "executor_tokens" RENAME CONSTRAINT "agent_tokens_pkey" TO "executor_tokens_pkey";
ALTER TABLE "executor_tokens" RENAME CONSTRAINT "agent_tokens_user_id_fkey" TO "executor_tokens_user_id_fkey";
ALTER INDEX "agent_tokens_token_hash_key" RENAME TO "executor_tokens_token_hash_key";

-- Rename agents.agent_token_id -> executor_token_id, and its constraint/index.
ALTER TABLE "agents" RENAME COLUMN "agent_token_id" TO "executor_token_id";
ALTER TABLE "agents" RENAME CONSTRAINT "agents_agent_token_id_fkey" TO "agents_executor_token_id_fkey";
ALTER INDEX "agents_token_id_host_key" RENAME TO "agents_executor_token_id_host_key";
