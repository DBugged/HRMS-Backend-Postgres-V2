-- Revisions of finalised payroll: the figures of a run as they were when it was unlocked for correction. Additive.
ALTER TABLE "payroll_runs" ADD COLUMN "revisionNumber" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "payroll_run_revisions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "runSequence" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL,
    "previousStatus" "PayrollRunStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "payroll_run_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payroll_run_revisions_payrollRunId_revision_key" ON "payroll_run_revisions"("payrollRunId", "revision");
CREATE INDEX "payroll_run_revisions_organizationId_payrollRunId_idx" ON "payroll_run_revisions"("organizationId", "payrollRunId");

ALTER TABLE "payroll_run_revisions" ADD CONSTRAINT "payroll_run_revisions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
