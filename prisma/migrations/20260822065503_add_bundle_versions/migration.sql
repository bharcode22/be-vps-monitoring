-- CreateTable
CREATE TABLE "bundle_definitions" (
    "id" SERIAL NOT NULL,
    "bundle_name" TEXT NOT NULL,
    "bundle_version" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'dev',
    "description" TEXT,
    "mobile_api_version" TEXT NOT NULL,
    "mobile_synch_version" TEXT NOT NULL,
    "mobile_consume_version" TEXT NOT NULL,
    "mobile_downloader_version" TEXT NOT NULL,
    "assist_api_version" TEXT NOT NULL,
    "small_screen_version" TEXT NOT NULL,
    "big_screen_version" TEXT NOT NULL,
    "created_by" TEXT DEFAULT 'Admin',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundle_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod_bundle_states" (
    "id" SERIAL NOT NULL,
    "pod_code" TEXT NOT NULL,
    "bundle_id" INTEGER,
    "custom_bundle_tag" TEXT,
    "compliance_status" TEXT NOT NULL DEFAULT 'synced',
    "compliance_pct" INTEGER NOT NULL DEFAULT 100,
    "last_deployed_by" TEXT DEFAULT 'Admin',
    "last_deployed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_bundle_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bundle_definitions_bundle_name_key" ON "bundle_definitions"("bundle_name");

-- CreateIndex
CREATE UNIQUE INDEX "pod_bundle_states_pod_code_key" ON "pod_bundle_states"("pod_code");

-- CreateIndex
CREATE INDEX "pod_bundle_states_pod_code_idx" ON "pod_bundle_states"("pod_code");

-- AddForeignKey
ALTER TABLE "pod_bundle_states" ADD CONSTRAINT "pod_bundle_states_pod_code_fkey" FOREIGN KEY ("pod_code") REFERENCES "servers"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_bundle_states" ADD CONSTRAINT "pod_bundle_states_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundle_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
