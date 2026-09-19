-- Data-only: reorder the built-in Document Required rows into logical groups (identity, address, bank,
-- education, employment) to match DEFAULT_DOCUMENT_REQUIREMENTS. Only touches built-in rows' displayOrder.
UPDATE "document_requirements" r
SET "displayOrder" = d."ord", "updatedAt" = now()
FROM (VALUES ('Aadhaar Card', 0), ('PAN Card', 1), ('Passport', 2), ('Passport Photo', 3), ('Address Proof', 4),
             ('Bank Account Proof', 5), ('Bank Statement', 6), ('Educational Certificate', 7),
             ('Offer / Appointment Letter', 8), ('Salary Slips', 9)) AS d("name", "ord")
WHERE r."name" = d."name" AND r."isSystemDefault" = true;
