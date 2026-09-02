-- CreateTable
CREATE TABLE IF NOT EXISTS "user_activity_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "user_email" VARCHAR(100) NOT NULL,
    "user_name" VARCHAR(100),
    "user_role" VARCHAR(30) NOT NULL DEFAULT 'admin',
    "action" VARCHAR(50) NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "target" VARCHAR(100),
    "description" TEXT,
    "details" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
    "ip_address" VARCHAR(50),
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_activity_user_email" ON "user_activity_logs"("user_email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_activity_category" ON "user_activity_logs"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_activity_action" ON "user_activity_logs"("action");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_activity_created_at" ON "user_activity_logs"("created_at" DESC);
