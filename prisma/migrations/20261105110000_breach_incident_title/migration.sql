-- A breach incident gets a short title next to its number.
ALTER TABLE "breach_incidents" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
