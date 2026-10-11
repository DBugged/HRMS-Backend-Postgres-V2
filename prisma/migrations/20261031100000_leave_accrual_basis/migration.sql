-- Periodic accrual can count its cycles from each employee's joining date instead of the leave year. Additive; every
-- existing leave type stays on the leave-year basis.
CREATE TYPE "AccrualBasis" AS ENUM ('LEAVE_YEAR', 'JOINING_ANNIVERSARY');
ALTER TABLE "leave_types" ADD COLUMN "accrualBasis" "AccrualBasis" NOT NULL DEFAULT 'LEAVE_YEAR';
