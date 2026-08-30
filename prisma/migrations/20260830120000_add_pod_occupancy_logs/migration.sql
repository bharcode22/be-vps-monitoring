-- CreateTable
CREATE TABLE IF NOT EXISTS "pod_occupancy_logs" (
    "id" SERIAL NOT NULL,
    "server_id" INTEGER NOT NULL,
    "server_name" VARCHAR(100),
    "server_code" VARCHAR(50),
    "server_host" VARCHAR(50),
    "state_value" INTEGER NOT NULL,
    "state_label" VARCHAR(30) NOT NULL,
    "topic" VARCHAR(255),
    "raw_payload" TEXT,
    "duration_seconds" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_occupancy_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_occupancy_logs_server_id" ON "pod_occupancy_logs"("server_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_occupancy_logs_created_at" ON "pod_occupancy_logs"("created_at" DESC);
