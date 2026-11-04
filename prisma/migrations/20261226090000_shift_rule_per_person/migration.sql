-- Shift rules can name people (a per-person override) instead of, or as well as, a gender.
ALTER TABLE "shift_rules" ALTER COLUMN "gender" DROP NOT NULL;
ALTER TABLE "shift_rules" ADD COLUMN "employeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
