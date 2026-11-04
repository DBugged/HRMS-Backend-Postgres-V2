-- Gender-wise shift rules and named overtime rule sets (both per organisation).
CREATE TABLE "shift_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER,
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shift_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shift_rules_organizationId_name_key" ON "shift_rules"("organizationId", "name");
CREATE INDEX "shift_rules_organizationId_idx" ON "shift_rules"("organizationId");
ALTER TABLE "shift_rules" ADD CONSTRAINT "shift_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "overtime_rule_sets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "policy" JSONB NOT NULL DEFAULT '{}',
    "rates" JSONB,
    "employeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "employeeTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effectiveFrom" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "overtime_rule_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "overtime_rule_sets_organizationId_name_key" ON "overtime_rule_sets"("organizationId", "name");
CREATE INDEX "overtime_rule_sets_organizationId_idx" ON "overtime_rule_sets"("organizationId");
ALTER TABLE "overtime_rule_sets" ADD CONSTRAINT "overtime_rule_sets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
