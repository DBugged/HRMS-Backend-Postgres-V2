-- Nine employment stages. The notice stage is now RESIGNED (resignation accepted, serving notice) and the final status
-- of a normal exit is RELEASED. Existing data is moved in one pass per column so nothing is mapped twice:
--   RESIGNED (had left)        -> RELEASED
--   NOTICE_PERIOD (serving)    -> RESIGNED
-- The NOTICE_PERIOD enum value stays (retired, unused) so the type is not rebuilt.
UPDATE "users"
SET "employmentStatus" = (CASE "employmentStatus"::text
  WHEN 'RESIGNED' THEN 'RELEASED'
  WHEN 'NOTICE_PERIOD' THEN 'RESIGNED'
END)::"EmploymentStatus"
WHERE "employmentStatus"::text IN ('RESIGNED', 'NOTICE_PERIOD');

UPDATE "employment_status_history"
SET "previousStatus" = (CASE "previousStatus"::text
  WHEN 'RESIGNED' THEN 'RELEASED'
  WHEN 'NOTICE_PERIOD' THEN 'RESIGNED'
END)::"EmploymentStatus"
WHERE "previousStatus"::text IN ('RESIGNED', 'NOTICE_PERIOD');

UPDATE "employment_status_history"
SET "newStatus" = (CASE "newStatus"::text
  WHEN 'RESIGNED' THEN 'RELEASED'
  WHEN 'NOTICE_PERIOD' THEN 'RESIGNED'
END)::"EmploymentStatus"
WHERE "newStatus"::text IN ('RESIGNED', 'NOTICE_PERIOD');

UPDATE "offboarding_cases"
SET "exitStatus" = (CASE "exitStatus"::text
  WHEN 'RESIGNED' THEN 'RELEASED'
  WHEN 'NOTICE_PERIOD' THEN 'RESIGNED'
END)::"EmploymentStatus"
WHERE "exitStatus"::text IN ('RESIGNED', 'NOTICE_PERIOD');

UPDATE "offboarding_cases"
SET "previousEmploymentStatus" = (CASE "previousEmploymentStatus"::text
  WHEN 'RESIGNED' THEN 'RELEASED'
  WHEN 'NOTICE_PERIOD' THEN 'RESIGNED'
END)::"EmploymentStatus"
WHERE "previousEmploymentStatus"::text IN ('RESIGNED', 'NOTICE_PERIOD');
