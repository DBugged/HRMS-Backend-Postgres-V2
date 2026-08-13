# HRMS Backend v2 — NestJS + Prisma + PostgreSQL

Phase 1 of a long-term, multi-session migration of the HRMS backend from
Express/Sequelize/MySQL (`../backend`, which stays running as-is and is
untouched by this repo) to NestJS/Prisma/PostgreSQL. This phase implements
only the foundation: multi-tenant Auth + RBAC, proven end-to-end. Every
other module (Employees, Payroll, Attendance, ...) is a later phase.

## What's here

- **Auth**: self-serve org registration, login, JWT access token (15 min) +
  opaque, rotating, revocable refresh token (7 days) delivered both as an
  httpOnly cookie (web) and in the response body (mobile, no cookie jar).
- **RBAC**: `Role` enum (`ADMIN`, `HR`, `MANAGER`, `EMPLOYEE`), one
  `RolesGuard` + two decorators (`@Roles()`, `@SelfOrRoles()`) covering both
  role-gated and self-or-role authorization patterns — see
  `src/common/guards/roles.guard.ts` for how a future Super Admin role
  plugs in without touching this mechanism.
- **Tenant isolation**: a Prisma Client Extension
  (`src/prisma/tenant-scope.extension.ts`) that throws at runtime if a
  query against `User`/`RefreshToken` is missing an `organizationId`
  filter — the Prisma equivalent of the old Sequelize backend's
  `enforceTenantScope` hooks.
- **Swagger**: `GET /api/docs` — every request/response DTO is
  simultaneously the `class-validator` source of truth and the Swagger
  schema source.

## Local setup

Requires PostgreSQL. If not already running:

```bash
brew install postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE ROLE hrms_v2_user WITH LOGIN PASSWORD 'hrms_v2_pass';"
psql postgres -c "CREATE DATABASE hrms_v2_dev OWNER hrms_v2_user;"
psql postgres -c "ALTER ROLE hrms_v2_user CREATEDB;"  # needed for Prisma's shadow database
```

Then:

```bash
cp .env.example .env   # generate real JWT_ACCESS_SECRET/JWT_REFRESH_SECRET, e.g. via `openssl rand -hex 32`
npm install
npx prisma migrate dev
npm run start:dev       # listens on :4000, Swagger at /api/docs
```

## Manual verification

No automated test suite in this phase (per project scope — QA is handled
separately). To verify Auth + RBAC end-to-end against a disposable local
org:

```bash
# 1. Register
curl -s -X POST localhost:4000/auth/register -H 'Content-Type: application/json' \
  -d '{"organizationName":"QA Org","name":"QA Founder","email":"qa@example.test","password":"TestPass123!"}'

# 2. Login (note the organizationId from step 1's response)
curl -s -X POST localhost:4000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"qa@example.test","password":"TestPass123!"}' -c cookies.txt

# 3. Seed one HR/Manager/Employee test user in that org (register always
#    creates an ADMIN founder, so this is the only way to get the other
#    roles for testing)
npx ts-node scripts/seed-qa-users.ts <organizationId-from-step-1>

# 4. Exercise the RBAC proof endpoint as each role
curl -s localhost:4000/organizations/me -H "Authorization: Bearer <accessToken>"
# ADMIN/HR -> 200, MANAGER/EMPLOYEE -> 403

# 5. Refresh (rotates the token) and logout (revokes it)
curl -s -X POST localhost:4000/auth/refresh -b cookies.txt -c cookies.txt
curl -s -X POST localhost:4000/auth/logout -b cookies.txt
```

To reset the disposable dev database entirely: `npx prisma migrate reset`.

## Explicitly out of scope this phase

Employees/Payroll/Attendance/etc. modules, data migration from the live
MySQL database, Next.js web, mobile TypeScript, Redis/BullMQ/Resend/R2,
Sentry, Super Admin, payments/billing. See the architecture review and
migration plan for the full roadmap.
