-- The month the leave year starts (1 = calendar year, the default) and, after a January -> other-month transition, the
-- first year that starts in it. Additive; every organisation keeps the calendar year.
ALTER TABLE "organizations" ADD COLUMN "leaveYearStartMonth" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN "leaveYearAnchorYear" INTEGER;
