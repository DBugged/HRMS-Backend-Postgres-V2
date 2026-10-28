-- AlterTable
ALTER TABLE "users" ADD COLUMN "alwaysPresent" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "alwaysPresentFrom" TEXT;
