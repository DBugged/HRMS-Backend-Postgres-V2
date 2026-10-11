-- Marks tax slabs that payroll copied forward from an earlier year, until someone reviews and saves them. Additive.
ALTER TABLE "tax_slab_configs" ADD COLUMN "isCarriedForward" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tax_slab_configs" ADD COLUMN "carriedForwardFrom" TEXT;
