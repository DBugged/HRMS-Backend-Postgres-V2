-- Marks the 4 baseline Document Required rows as built-in (name locked, not deletable). Additive:
-- one new NOT NULL column with a default, then flag the already-seeded baseline rows by name.
ALTER TABLE "document_requirements" ADD COLUMN "isSystemDefault" BOOLEAN NOT NULL DEFAULT false;

UPDATE "document_requirements"
SET "isSystemDefault" = true
WHERE "name" IN ('PAN Card', 'Aadhaar Card', 'Passport Photo', 'Educational Certificate');
