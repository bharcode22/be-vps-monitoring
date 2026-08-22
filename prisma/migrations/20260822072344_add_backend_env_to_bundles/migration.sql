-- AlterTable
ALTER TABLE "bundle_definitions" ADD COLUMN     "assist_api_env" TEXT DEFAULT '',
ADD COLUMN     "assist_api_prisma" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobile_api_env" TEXT DEFAULT '',
ADD COLUMN     "mobile_api_prisma" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobile_consume_env" TEXT DEFAULT '',
ADD COLUMN     "mobile_consume_prisma" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobile_downloader_env" TEXT DEFAULT '',
ADD COLUMN     "mobile_downloader_prisma" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobile_synch_env" TEXT DEFAULT '',
ADD COLUMN     "mobile_synch_prisma" BOOLEAN NOT NULL DEFAULT false;
