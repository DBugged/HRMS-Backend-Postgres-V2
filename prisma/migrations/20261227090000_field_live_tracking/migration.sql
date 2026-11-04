-- Live tracking for field staff (Phase 1): who is tracked + consent on the user, the samples, and the company switch.
ALTER TABLE "users" ADD COLUMN "fieldTrackingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "fieldTrackingConsentAt" TIMESTAMP(3);

CREATE TABLE "location_pings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyMeters" DOUBLE PRECISION,
    "speedMps" DOUBLE PRECISION,
    "batteryPercent" INTEGER,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'POINT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "location_pings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "location_pings_employeeId_recordedAt_kind_key" ON "location_pings"("employeeId", "recordedAt", "kind");
CREATE INDEX "location_pings_organizationId_employeeId_recordedAt_idx" ON "location_pings"("organizationId", "employeeId", "recordedAt");
CREATE INDEX "location_pings_organizationId_recordedAt_idx" ON "location_pings"("organizationId", "recordedAt");
ALTER TABLE "location_pings" ADD CONSTRAINT "location_pings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "location_pings" ADD CONSTRAINT "location_pings_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The company switch: OFF by default; a Super Admin turns it on per company in the Control Panel (Organization > Features).
INSERT INTO "cc_feature_flags" ("key","description","defaultValue","status","updatedAt") VALUES
('feature.field_tracking','Live tracking of field employees: location shared during their shift (with their consent) for the people Admin / HR switch it on for. Off by default.','false','ACTIVE',now())
ON CONFLICT ("key") DO NOTHING;
