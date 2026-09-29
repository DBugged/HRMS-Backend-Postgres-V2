-- Standing opt-out from bulk payroll runs (PayrollService.targetEmployees)
-- for an employee tracked in the HRMS but never actually paid through it.
ALTER TABLE "users" ADD COLUMN "excludeFromPayroll" BOOLEAN NOT NULL DEFAULT false;
