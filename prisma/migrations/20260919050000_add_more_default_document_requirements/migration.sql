-- Data-only backfill: add six more built-in Document Required rows (Address Proof, Bank Account Proof,
-- Offer / Appointment Letter, Passport, Bank Statement, Salary Slips) to every existing organization, matching
-- DEFAULT_DOCUMENT_REQUIREMENTS for new orgs. Optional (isMandatory = false) so nobody is suddenly flagged as
-- missing documents; existing rows with the same name are left alone. Additive only — no schema change.
INSERT INTO "document_requirements" ("id", "organizationId", "name", "isMandatory", "isSystemDefault", "isActive", "displayOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", d."name", false, true, true, d."ord", now(), now()
FROM "organizations" o
CROSS JOIN (VALUES ('Address Proof', 4), ('Bank Account Proof', 5), ('Offer / Appointment Letter', 6), ('Passport', 7), ('Bank Statement', 8), ('Salary Slips', 9)) AS d("name", "ord")
ON CONFLICT ("organizationId", "name") DO NOTHING;
