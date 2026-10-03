-- Data-only, additive: gives every EXISTING org the built-in Reason for
-- Leaving list that new orgs get at registration (OrgListItemsService
-- .seedDefaults) — the same values that used to be hardcoded. Inserts only
-- what's missing and never updates or deletes a row. Not isSystemDefault:
-- HR can rename or delete any of them (the reason is stored as plain text
-- on each exit interview, so nothing is orphaned).
INSERT INTO "org_list_items" ("id", "organizationId", "type", "name", "isActive", "isSystemDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o."id", 'REASON_FOR_LEAVING'::"OrgListType", r."name", true, false, NOW(), NOW()
FROM "organizations" o
CROSS JOIN (VALUES
  ('Better Opportunity'), ('Compensation'), ('Career Growth'), ('Relocation'),
  ('Personal Reasons'), ('Work Environment'), ('Health'), ('Other')
) AS r("name")
ON CONFLICT ("organizationId", "type", "name") DO NOTHING;
