-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "servers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL DEFAULT 'root',
    "auth_type" TEXT NOT NULL DEFAULT 'password',
    "password" TEXT,
    "private_key" TEXT,
    "is_local" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL DEFAULT 'vps',
    "pod_version" TEXT NOT NULL DEFAULT '',
    "db_name" TEXT NOT NULL DEFAULT '',
    "db_user" TEXT NOT NULL DEFAULT '',
    "s3_endpoint" TEXT NOT NULL DEFAULT '',
    "s3_access_key" TEXT NOT NULL DEFAULT '',
    "s3_secret_key" TEXT NOT NULL DEFAULT '',
    "s3_region" TEXT NOT NULL DEFAULT 'us-east-1',
    "s3_bucket" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "picture" TEXT,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "databases_postgres" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 5432,
    "db_name" TEXT NOT NULL DEFAULT 'postgres',
    "db_user" TEXT NOT NULL DEFAULT 'postgres',
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "databases_postgres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_storages" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "s3_endpoint" TEXT,
    "s3_access_key" TEXT,
    "s3_secret_key" TEXT,
    "s3_region" TEXT DEFAULT 'us-east-1',
    "s3_bucket" TEXT,
    "port" INTEGER NOT NULL DEFAULT 9000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "object_storages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rabbitmq_servers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 15672,
    "username" TEXT NOT NULL DEFAULT 'guest',
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rabbitmq_servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

