-- Cross-border flag on processors and sharing records, and a per-employee privacy nominee (DPDP).
ALTER TABLE "data_processors" ADD COLUMN "crossBorder" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "data_processors" ADD COLUMN "crossBorderCountry" TEXT NOT NULL DEFAULT '';
ALTER TABLE "data_sharing_records" ADD COLUMN "crossBorder" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "data_sharing_records" ADD COLUMN "crossBorderCountry" TEXT NOT NULL DEFAULT '';

CREATE TABLE "privacy_nominees" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_nominees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "privacy_nominees_organizationId_userId_key" ON "privacy_nominees"("organizationId", "userId");

ALTER TABLE "privacy_nominees" ADD CONSTRAINT "privacy_nominees_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
