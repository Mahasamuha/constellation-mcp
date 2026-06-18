-- CreateEnum
CREATE TYPE "RelayRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ExecutorTokenType" AS ENUM ('NODE', 'HUB');

-- CreateEnum
CREATE TYPE "DisconnectReason" AS ENUM ('clean', 'timeout', 'error');

-- CreateEnum
CREATE TYPE "PatternType" AS ENUM ('glob', 'regex');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('tool_call', 'tool_error', 'rate_limited', 'executor_connect', 'executor_disconnect');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "oidc_sub" TEXT,
    "oidc_issuer" TEXT,
    "email" TEXT NOT NULL,
    "role" "RelayRole" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMP(3),
    "last_known_claims" JSONB,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "local_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executor_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "token_type" "ExecutorTokenType" NOT NULL DEFAULT 'NODE',
    "token_hash" TEXT NOT NULL,
    "approved_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "executor_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executors" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "executor_token_id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMP(3),
    "last_disconnect_reason" "DisconnectReason",

    CONSTRAINT "executors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "path_shares" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "executor_id" TEXT NOT NULL,
    "share" TEXT NOT NULL,
    "reported_path" TEXT NOT NULL,
    "instructions" TEXT,

    CONSTRAINT "path_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_path_filters" (
    "id" TEXT NOT NULL,
    "scope_user_id" TEXT NOT NULL,
    "scope_executor_id" TEXT,
    "pattern" TEXT NOT NULL,
    "pattern_type" "PatternType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relay_path_filters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT,
    "event_type" "ActivityEventType" NOT NULL,
    "host" TEXT,
    "tool" TEXT,
    "share" TEXT,
    "request_id" TEXT,
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_failures" (
    "id" SERIAL NOT NULL,
    "ip" TEXT NOT NULL,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_codes" (
    "code_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT,
    "code_challenge_method" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_codes_pkey" PRIMARY KEY ("code_hash")
);

-- CreateTable
CREATE TABLE "device_codes" (
    "device_code" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "user_id" TEXT,
    "host_name" TEXT,
    "pending_user_id" TEXT,
    "elevate_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_codes_pkey" PRIMARY KEY ("device_code")
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "client_secret_hash" TEXT,
    "redirect_uris" TEXT[],
    "grant_types" TEXT[],
    "is_dynamic" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mcp_client_id" TEXT NOT NULL,
    "access_token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_token_hash" TEXT,
    "refresh_token_expires_at" TIMESTAMP(3),
    "admin_until" TIMESTAMP(3),

    CONSTRAINT "oauth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_shares" (
    "id" TEXT NOT NULL,
    "executor_id" TEXT NOT NULL,
    "share" TEXT NOT NULL,
    "reported_path" TEXT NOT NULL,
    "permission_blob" JSONB NOT NULL,
    "instructions" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hub_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_oidc_sub_oidc_issuer_key" ON "users"("oidc_sub", "oidc_issuer");

-- CreateIndex
CREATE UNIQUE INDEX "local_users_username_key" ON "local_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "local_users_user_id_key" ON "local_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "executor_tokens_token_hash_key" ON "executor_tokens"("token_hash");

-- CreateIndex
-- Partial unique indexes not expressible via @@unique in schema.prisma (Prisma
-- doesn't support WHERE on @@unique) — see the comment on model Executor.
-- Personal executors: (user_id, host) unique where user_id is not null.
CREATE UNIQUE INDEX "executors_user_id_host_key" ON "executors"("user_id", "host") WHERE "user_id" IS NOT NULL;

-- CreateIndex
-- Hub executors: (executor_token_id, host) unique — token scopes the installation.
CREATE UNIQUE INDEX "executors_executor_token_id_host_key" ON "executors"("executor_token_id", "host");

-- CreateIndex
CREATE UNIQUE INDEX "path_shares_user_id_share_key" ON "path_shares"("user_id", "share");

-- CreateIndex
CREATE INDEX "activity_logs_user_id_created_at_idx" ON "activity_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "login_failures_ip_failed_at_idx" ON "login_failures"("ip", "failed_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_codes_user_code_key" ON "device_codes"("user_code");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_sessions_access_token_hash_key" ON "oauth_sessions"("access_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_sessions_refresh_token_hash_key" ON "oauth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "hub_shares_executor_id_share_key" ON "hub_shares"("executor_id", "share");

-- AddForeignKey
ALTER TABLE "local_users" ADD CONSTRAINT "local_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executor_tokens" ADD CONSTRAINT "executor_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executors" ADD CONSTRAINT "executors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executors" ADD CONSTRAINT "executors_executor_token_id_fkey" FOREIGN KEY ("executor_token_id") REFERENCES "executor_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "path_shares" ADD CONSTRAINT "path_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "path_shares" ADD CONSTRAINT "path_shares_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_path_filters" ADD CONSTRAINT "relay_path_filters_scope_user_id_fkey" FOREIGN KEY ("scope_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_path_filters" ADD CONSTRAINT "relay_path_filters_scope_executor_id_fkey" FOREIGN KEY ("scope_executor_id") REFERENCES "executors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_mcp_client_id_fkey" FOREIGN KEY ("mcp_client_id") REFERENCES "oauth_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_shares" ADD CONSTRAINT "hub_shares_executor_id_fkey" FOREIGN KEY ("executor_id") REFERENCES "executors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
