-- Data-only, additive: gives every EXISTING org the built-in ASSET_CATEGORY
-- list that new orgs now get at registration (OrgListItemsService.seedDefaults).
-- Same one-off backfill pattern the EMPLOYEE_CATEGORY defaults used. Inserts
-- only what's missing (ON CONFLICT DO NOTHING against the
-- [organizationId, type, name] unique) and never updates or deletes a row.
INSERT INTO "org_list_items" ("id", "organizationId", "type", "name", "isActive", "isSystemDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o."id", 'ASSET_CATEGORY'::"OrgListType", c."name", true, true, NOW(), NOW()
FROM "organizations" o
CROSS JOIN (VALUES
  ('Laptop'), ('Desktop'), ('Monitor'), ('Mobile'), ('Tablet'), ('Printer'),
  ('Network Equipment'), ('Keyboard'), ('Mouse'), ('Headset'),
  ('Software License'), ('Vehicle'), ('Furniture'), ('ID Card'),
  ('Access Card'), ('Other')
) AS c("name")
ON CONFLICT ("organizationId", "type", "name") DO NOTHING;
