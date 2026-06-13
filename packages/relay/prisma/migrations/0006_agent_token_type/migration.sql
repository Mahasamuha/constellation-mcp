-- CreateEnum
CREATE TYPE "AgentTokenType" AS ENUM ('PERSONAL', 'SHARED');

-- AlterTable: add token_type column, backfill existing rows as PERSONAL
ALTER TABLE "agent_tokens" ADD COLUMN "token_type" "AgentTokenType" NOT NULL DEFAULT 'PERSONAL';

-- AlterTable: make user_id nullable to support service-level shared tokens
ALTER TABLE "agent_tokens" ALTER COLUMN "user_id" DROP NOT NULL;
