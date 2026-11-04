-- Client visits for field employees (live tracking, phase 2): plan, check in / out at the client's location, report.
CREATE TYPE "FieldVisitStatus" AS ENUM ('PLANNED', 'CHECKED_IN', 'COMPLETED', 'MISSED', 'CANCELLED');

CREATE TABLE "field_visits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "radiusMeters" INTEGER NOT NULL DEFAULT 150,
    "purpose" TEXT NOT NULL DEFAULT '',
    "scheduledFor" TEXT NOT NULL,
    "status" "FieldVisitStatus" NOT NULL DEFAULT 'PLANNED',
    "checkInAt" TIMESTAMP(3),
    "checkInLatitude" DOUBLE PRECISION,
    "checkInLongitude" DOUBLE PRECISION,
    "checkInAccuracyMeters" DOUBLE PRECISION,
    "checkInDistanceMeters" DOUBLE PRECISION,
    "checkInWithinRange" BOOLEAN,
    "checkOutAt" TIMESTAMP(3),
    "checkOutLatitude" DOUBLE PRECISION,
    "checkOutLongitude" DOUBLE PRECISION,
    "outcome" TEXT NOT NULL DEFAULT '',
    "durationMinutes" INTEGER,
    "autoClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "field_visits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "field_visits_organizationId_scheduledFor_idx" ON "field_visits"("organizationId", "scheduledFor");
CREATE INDEX "field_visits_organizationId_employeeId_scheduledFor_idx" ON "field_visits"("organizationId", "employeeId", "scheduledFor");
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
