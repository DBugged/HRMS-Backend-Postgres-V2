-- Tax gaps: home-loan interest (24b), 80TTA, section 89 relief, 206AA switch, concessional-loan perquisite rate.
ALTER TABLE "employee_tax_declarations" ADD COLUMN "homeLoanInterest" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "employee_tax_declarations" ADD COLUMN "section80TTA" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "employee_tax_declarations" ADD COLUMN "section89Relief" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "payroll_settings" ADD COLUMN "higherTdsWithoutPan" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payroll_settings" ADD COLUMN "perquisiteLoanBenchmarkRate" DOUBLE PRECISION NOT NULL DEFAULT 0;
