-- Backfill users."exitDate" for exits recorded before the column existed: the last working day of each person's latest
-- open or completed offboarding case. People still working (no such case, or only cancelled ones) stay NULL.
UPDATE "users" u
SET "exitDate" = c."lastWorkingDay"
FROM (
  SELECT DISTINCT ON ("employeeId") "employeeId", "lastWorkingDay"
  FROM "offboarding_cases"
  WHERE "status" IN ('INITIATED', 'IN_PROGRESS', 'COMPLETED')
  ORDER BY "employeeId", "createdAt" DESC
) c
WHERE u."id" = c."employeeId" AND u."exitDate" IS NULL;
