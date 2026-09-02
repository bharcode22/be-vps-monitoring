-- CreateTable
CREATE TABLE IF NOT EXISTS "pod_heartbeat_alerts" (
    "id" SERIAL NOT NULL,
    "server_id" INTEGER,
    "server_name" VARCHAR(100),
    "module_id" INTEGER NOT NULL,
    "module_name" VARCHAR(100),
    "alert_type" VARCHAR(30) NOT NULL,
    "message" TEXT,
    "last_hb" BIGINT,
    "duration_seconds" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_heartbeat_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_hb_alerts_server_id" ON "pod_heartbeat_alerts"("server_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_hb_alerts_created_at" ON "pod_heartbeat_alerts"("created_at" DESC);
