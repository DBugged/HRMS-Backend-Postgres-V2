-- An uploaded letter can be hidden from the employee it belongs to; existing rows stay visible.
ALTER TABLE "employee_documents" ADD COLUMN "visibleToEmployee" BOOLEAN NOT NULL DEFAULT true;
