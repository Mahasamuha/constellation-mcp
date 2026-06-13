-- CreateTable
CREATE TABLE "login_failures" (
    "id" SERIAL NOT NULL,
    "ip" TEXT NOT NULL,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_failures_ip_failed_at_idx" ON "login_failures"("ip", "failed_at");
