-- State/UT of a Work Location, used to pick state-wise statutory rates (Labour Welfare Fund). Additive:
-- one NOT NULL column with an empty-string default, so every existing location simply reads as "not set".
ALTER TABLE "work_locations" ADD COLUMN "state" TEXT NOT NULL DEFAULT '';
