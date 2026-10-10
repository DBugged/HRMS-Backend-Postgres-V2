-- Event-leave grant requests follow the leave type's approval levels: a manager's level-1 sign-off is recorded
-- before the final decision. Additive only.
ALTER TABLE "leave_grant_requests" ADD COLUMN "level1ApprovedById" TEXT;
ALTER TABLE "leave_grant_requests" ADD COLUMN "level1ApprovedAt" TIMESTAMP(3);
ALTER TABLE "leave_grant_requests" ADD COLUMN "level1Comments" TEXT;
