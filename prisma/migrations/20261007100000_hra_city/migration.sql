-- HRA: record the city of residence; "metro" is derived from it (8 cities from 1-Apr-2026).
ALTER TABLE "employee_tax_declarations" ADD COLUMN "hraCity" TEXT NOT NULL DEFAULT '';
