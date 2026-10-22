-- Control Center (platform) Super Admins: accounts that sign in to the Control Panel, separate from every company's users.
CREATE TYPE "SuperAdminRole" AS ENUM ('OWNER', 'ADMIN', 'SUPPORT', 'BILLING', 'READ_ONLY');
CREATE TYPE "SuperAdminStatus" AS ENUM ('ACTIVE', 'INVITED', 'DEACTIVATED');

CREATE TABLE "super_admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "SuperAdminRole" NOT NULL DEFAULT 'READ_ONLY',
    "status" "SuperAdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordResetTokenHash" TEXT,
    "passwordResetExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "super_admins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "super_admins_email_key" ON "super_admins"("email");

-- One row per signed-in browser; the refresh token is stored only as a hash and rotated on every refresh.
CREATE TABLE "super_admin_sessions" (
    "id" TEXT NOT NULL,
    "superAdminId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "super_admin_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "super_admin_sessions_tokenHash_key" ON "super_admin_sessions"("tokenHash");
CREATE INDEX "super_admin_sessions_superAdminId_idx" ON "super_admin_sessions"("superAdminId");

ALTER TABLE "super_admin_sessions" ADD CONSTRAINT "super_admin_sessions_superAdminId_fkey" FOREIGN KEY ("superAdminId") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
