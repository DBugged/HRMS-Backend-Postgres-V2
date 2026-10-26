-- The date an employee was confirmed from. New column, then a backfill for people already confirmed: the "Effective <date>"
-- written into the probation decision's history note when there is one, otherwise the day the status was changed to Confirmed.
ALTER TABLE "users" ADD COLUMN "confirmationDate" TEXT;

UPDATE "users" u
SET "confirmationDate" = c.d
FROM (
  SELECT DISTINCT ON ("employeeId") "employeeId",
         COALESCE(substring("note" from 'Effective ([0-9]{4}-[0-9]{2}-[0-9]{2})'), to_char("changedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')) AS d
  FROM "employment_status_history"
  WHERE "newStatus" = 'CONFIRMED'
  ORDER BY "employeeId", "changedAt" DESC
) c
WHERE u."id" = c."employeeId" AND u."employmentStatus" = 'CONFIRMED' AND u."confirmationDate" IS NULL;
