-- CreateIndex
CREATE INDEX "audit_logs_organizationId_module_createdAt_idx" ON "audit_logs"("organizationId", "module", "createdAt");

-- CreateIndex
CREATE INDEX "comp_offs_organizationId_status_idx" ON "comp_offs"("organizationId", "status");

-- CreateIndex
CREATE INDEX "comp_offs_organizationId_createdAt_idx" ON "comp_offs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "leave_encashments_organizationId_status_idx" ON "leave_encashments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "leave_encashments_organizationId_createdAt_idx" ON "leave_encashments"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "leaves_organizationId_status_idx" ON "leaves"("organizationId", "status");

-- CreateIndex
CREATE INDEX "leaves_organizationId_createdAt_idx" ON "leaves"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "loans_organizationId_status_idx" ON "loans"("organizationId", "status");

-- CreateIndex
CREATE INDEX "loans_organizationId_createdAt_idx" ON "loans"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "offboarding_cases_organizationId_status_idx" ON "offboarding_cases"("organizationId", "status");

-- CreateIndex
CREATE INDEX "offboarding_cases_organizationId_createdAt_idx" ON "offboarding_cases"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "reimbursements_organizationId_status_idx" ON "reimbursements"("organizationId", "status");

-- CreateIndex
CREATE INDEX "reimbursements_organizationId_createdAt_idx" ON "reimbursements"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "settlements_organizationId_status_idx" ON "settlements"("organizationId", "status");

-- CreateIndex
CREATE INDEX "settlements_organizationId_createdAt_idx" ON "settlements"("organizationId", "createdAt");

