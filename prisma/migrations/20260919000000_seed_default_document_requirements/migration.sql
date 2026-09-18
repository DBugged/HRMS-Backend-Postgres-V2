-- Data-only backfill: give every existing organization the 4 baseline Document Required rows that new
-- orgs now get at registration (DocumentsService.seedDefaults). Optional (isMandatory = false) so it
-- doesn't suddenly flag anyone as missing documents; orgs that already created a row with the same
-- name are left alone (unique on organizationId + name). Additive only — no schema change.
INSERT INTO "document_requirements" ("id", "organizationId", "name", "isMandatory", "isActive", "displayOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", d."name", false, true, d."ord", now(), now()
FROM "organizations" o
CROSS JOIN (VALUES ('PAN Card', 0), ('Aadhaar Card', 1), ('Passport Photo', 2), ('Educational Certificate', 3)) AS d("name", "ord")
ON CONFLICT ("organizationId", "name") DO NOTHING;
