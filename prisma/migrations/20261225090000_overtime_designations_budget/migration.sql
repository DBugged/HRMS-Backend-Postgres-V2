-- Overtime rule sets can target designations; departments can carry a monthly overtime budget (hours).
ALTER TABLE "overtime_rule_sets" ADD COLUMN "designations" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "departments" ADD COLUMN "overtimeBudgetHours" DOUBLE PRECISION;
