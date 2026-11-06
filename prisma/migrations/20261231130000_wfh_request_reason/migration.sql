-- The employee's own reason for a Work From Home request, on each day of the request. Optional: NULL = no reason given,
-- which is every request made so far and every request from an app version that does not send one.
ALTER TABLE "attendances" ADD COLUMN "workArrangementReason" TEXT;
