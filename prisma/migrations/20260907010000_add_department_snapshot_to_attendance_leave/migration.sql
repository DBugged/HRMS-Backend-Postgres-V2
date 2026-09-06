-- AlterTable: point-in-time department snapshot columns (nullable, no FK —
-- see the schema.prisma comments on Attendance.departmentId/Leave.departmentId).
ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;
ALTER TABLE "leaves" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;

-- Backfill: best-effort approximation for pre-existing rows using each
-- employee's CURRENT department — this is not historically accurate for an
-- employee who has since been transferred, but it's strictly better than
-- NULL (which every row would otherwise have forever) and matches exactly
-- what every report already showed for these rows before this migration.
UPDATE "attendances" a
SET "departmentId" = u."departmentId"
FROM "users" u
WHERE a."employeeId" = u."id" AND a."departmentId" IS NULL;

UPDATE "leaves" l
SET "departmentId" = u."departmentId"
FROM "users" u
WHERE l."employeeId" = u."id" AND l."departmentId" IS NULL;
