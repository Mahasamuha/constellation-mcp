-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('tool_call', 'tool_error', 'rate_limited', 'agent_connect', 'agent_disconnect');

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" "ActivityEventType" NOT NULL,
    "host" TEXT,
    "tool" TEXT,
    "label" TEXT,
    "request_id" TEXT,
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_logs_user_id_created_at_idx" ON "activity_logs"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
