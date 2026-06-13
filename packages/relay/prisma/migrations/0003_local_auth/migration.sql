-- AlterTable: make oidc_sub and oidc_issuer nullable for local auth users
ALTER TABLE "users" ALTER COLUMN "oidc_sub" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "oidc_issuer" DROP NOT NULL;

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

-- CreateIndex
CREATE UNIQUE INDEX "local_users_username_key" ON "local_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "local_users_user_id_key" ON "local_users"("user_id");

-- AddForeignKey
ALTER TABLE "local_users" ADD CONSTRAINT "local_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
