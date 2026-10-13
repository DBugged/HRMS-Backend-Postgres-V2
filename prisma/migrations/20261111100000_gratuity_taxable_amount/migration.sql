-- The part of a settlement's gratuity above its tax-exempt limit (taxed with the final pay).
ALTER TABLE "settlements" ADD COLUMN "gratuityTaxableAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
