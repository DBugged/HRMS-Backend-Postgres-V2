-- Extra employee-profile fields a company defines itself (Organization > Custom Fields), and where each employee's values live.
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'DROPDOWN', 'CHECKBOX');

CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "helpText" TEXT NOT NULL DEFAULT '',
    "section" TEXT NOT NULL DEFAULT 'Additional information',
    "employeeEditable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_field_definitions_organizationId_key_key" ON "custom_field_definitions"("organizationId", "key");
CREATE INDEX "custom_field_definitions_organizationId_idx" ON "custom_field_definitions"("organizationId");

ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Each employee's values, keyed by the field's key: { "blood_group": "O+", "has_vehicle": true }.
ALTER TABLE "users" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
