-- Org-wide auto-approve-after-N-hours for WFH and Regularization requests,
-- same idea as LeaveType.autoApproveIfNoAction/autoApproveHours but org-wide
-- since these two have no "type" of their own. Off by default.
ALTER TABLE "organizations" ADD COLUMN "wfhAutoApproveIfNoAction" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN "wfhAutoApproveHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "organizations" ADD COLUMN "regularizationAutoApproveIfNoAction" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN "regularizationAutoApproveHours" INTEGER NOT NULL DEFAULT 24;
