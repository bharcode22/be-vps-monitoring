-- AlterTable
ALTER TABLE "settings" DROP CONSTRAINT IF EXISTS "settings_pkey";
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "id" SERIAL NOT NULL;
ALTER TABLE "settings" ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "settings_key_key" ON "settings"("key");
