-- The default fonts are now Merriweather (headings) and Roboto (body text) instead of Plus Jakarta Sans and Inter.
-- New companies start with them; a company can still pick other fonts in Branding.
-- A column that still holds the old default was never customised, so it follows the new default. Any other pick is left alone.
ALTER TABLE "organizations" ALTER COLUMN "headingFont" SET DEFAULT 'Merriweather';
ALTER TABLE "organizations" ALTER COLUMN "bodyFont" SET DEFAULT 'Roboto';
UPDATE "organizations" SET "headingFont" = 'Merriweather' WHERE "headingFont" = 'Plus Jakarta Sans';
UPDATE "organizations" SET "bodyFont" = 'Roboto' WHERE "bodyFont" = 'Inter';
