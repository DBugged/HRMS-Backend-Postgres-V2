-- Investment proofs uploaded with a tax declaration (see EmployeeTaxDeclaration.proofs).
ALTER TABLE "employee_tax_declarations" ADD COLUMN "proofs" JSONB NOT NULL DEFAULT '[]';
