-- AlterTable: marks a built-in Employee Category (Full-Time/Part-Time/
-- Contract/Intern) so its name can be locked and it can't be deleted —
-- same isSystemDefault concept as LeaveType, scoped to type =
-- EMPLOYEE_CATEGORY only (Designations/Grades get no such protection).
-- Default false preserves current (fully editable/deletable) behavior for
-- every existing Designation/Grade/Category row.
ALTER TABLE "org_list_items" ADD COLUMN IF NOT EXISTS "isSystemDefault" BOOLEAN NOT NULL DEFAULT false;

-- Mark any EXISTING Employee Category row matching one of the 4 canonical
-- names (case-insensitive — an org may have typed "full-time" or
-- "Full Time" variants before this concept existed) as built-in.
UPDATE "org_list_items"
SET "isSystemDefault" = true
WHERE "type" = 'EMPLOYEE_CATEGORY'
  AND lower("name") IN ('full-time', 'part-time', 'contract', 'intern');

-- Backfill any of the 4 canonical categories an org doesn't already have
-- (case-insensitive match against whatever it already has), so every
-- existing org ends up with the same built-in set a newly-registered org
-- gets from OrgListItemsService.seedDefaults() — not just the org's own
-- pre-existing subset (e.g. an org that only ever had "Full-Time" and
-- "Part-Time" gains built-in "Contract"/"Intern" too, active from the
-- start, exactly as if it had just registered).
INSERT INTO "org_list_items"
  (id, "organizationId", type, name, "isActive", "isSystemDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o.id, 'EMPLOYEE_CATEGORY'::"OrgListType", d.name, true, true, now(), now()
FROM "organizations" o
CROSS JOIN (VALUES ('Full-Time'), ('Part-Time'), ('Contract'), ('Intern')) AS d(name)
WHERE NOT EXISTS (
  SELECT 1 FROM "org_list_items" i
  WHERE i."organizationId" = o.id
    AND i."type" = 'EMPLOYEE_CATEGORY'
    AND lower(i."name") = lower(d.name)
);
