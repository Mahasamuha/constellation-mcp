-- Constellation becomes an OAuth resource server; asterism is the authorization server.
-- Drops the OAuth server, device-code, local-account and login-failure tables and reduces
-- users to (id, created_at). users.id values are kept: other tables reference them.
-- DropForeignKey
ALTER TABLE "local_users" DROP CONSTRAINT "local_users_user_id_fkey";

-- DropForeignKey
ALTER TABLE "oauth_sessions" DROP CONSTRAINT "oauth_sessions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "oauth_sessions" DROP CONSTRAINT "oauth_sessions_mcp_client_id_fkey";

-- DropIndex
DROP INDEX "users_oidc_sub_oidc_issuer_key";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "deactivated_at",
DROP COLUMN "email",
DROP COLUMN "last_known_claims",
DROP COLUMN "oidc_issuer",
DROP COLUMN "oidc_sub",
DROP COLUMN "role";

-- DropTable
DROP TABLE "local_users";

-- DropTable
DROP TABLE "login_failures";

-- DropTable
DROP TABLE "auth_codes";

-- DropTable
DROP TABLE "device_codes";

-- DropTable
DROP TABLE "oauth_clients";

-- DropTable
DROP TABLE "oauth_sessions";

-- DropEnum
DROP TYPE "RelayRole";

