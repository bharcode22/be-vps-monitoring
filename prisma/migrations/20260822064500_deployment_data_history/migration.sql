-- CreateTable
CREATE TABLE "deployment_history" (
    "id" SERIAL NOT NULL,
    "batch_id" TEXT,
    "pod_code" TEXT,
    "server_name" TEXT,
    "app_name" TEXT NOT NULL,
    "app_type" TEXT NOT NULL DEFAULT 'backend',
    "environment" TEXT NOT NULL DEFAULT 'dev',
    "version" TEXT NOT NULL,
    "env_filename" TEXT,
    "run_prisma_migrate" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "logs" TEXT,
    "error_message" TEXT,
    "deployed_by" TEXT DEFAULT 'Admin',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod_app_versions" (
    "id" SERIAL NOT NULL,
    "pod_code" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "app_type" TEXT NOT NULL DEFAULT 'backend',
    "environment" TEXT NOT NULL DEFAULT 'dev',
    "current_version" TEXT NOT NULL,
    "last_deployment_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_app_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deployment_history_pod_code_idx" ON "deployment_history"("pod_code");

-- CreateIndex
CREATE INDEX "deployment_history_created_at_idx" ON "deployment_history"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "servers_code_key" ON "servers"("code");

-- CreateIndex
CREATE INDEX "pod_app_versions_pod_code_idx" ON "pod_app_versions"("pod_code");

-- CreateIndex
CREATE UNIQUE INDEX "pod_app_versions_pod_code_app_name_key" ON "pod_app_versions"("pod_code", "app_name");

-- AddForeignKey
ALTER TABLE "deployment_history" ADD CONSTRAINT "deployment_history_pod_code_fkey" FOREIGN KEY ("pod_code") REFERENCES "servers"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_app_versions" ADD CONSTRAINT "pod_app_versions_pod_code_fkey" FOREIGN KEY ("pod_code") REFERENCES "servers"("code") ON DELETE CASCADE ON UPDATE CASCADE;
