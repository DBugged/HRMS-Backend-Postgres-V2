# HRMS Backend v2 — NestJS + Prisma + PostgreSQL

A long-term, multi-session migration of the HRMS backend from
Express/Sequelize/MySQL (`../backend`, which stays running as-is and is
untouched by this repo) to NestJS/Prisma/PostgreSQL.

- **Phase 1**: Auth + RBAC foundation, proven end-to-end.
- **Phase 2**: Department + core Employee CRUD, stress-testing that
  foundation against real business logic (field-level self-update locking,
  department-scoped results, row-locked ID generation).

Every other module (Payroll, Attendance, Leave, ...) is a later phase.

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
  query against `User`/`RefreshToken`/`Department` is missing an
  `organizationId` filter, or uses a single-record op (`update`/`delete`/
  `upsert`/`findUnique`) that can't be organizationId-scoped at all — the
  Prisma equivalent of the old Sequelize backend's `enforceTenantScope`
  hooks. The exact set of guarded operations was verified empirically
  against the real generated client (`Object.getOwnPropertyNames`), not
  guessed from naming patterns — see the comment at the top of
  `tenant-scope.guard-logic.ts`.
- **Employees**: Employee IS the `User` row (no separate entity, same as
  the old system). Create/list(paginated+searchable)/get/update/deactivate,
  with the old system's self-vs-HR field-locking ported to
  `employee-field-lock.ts` and department-scoped list/get results for
  Managers ported to `employee-query-scope.ts` — both as small, unit-tested
  pure functions rather than inline controller logic.
- **Departments**: minimal CRUD backing the Employees module.
- **Row-locked ID generation**: `employee-id.service.ts` uses
  `SELECT ... FOR UPDATE` on the Organization row inside the same
  transaction that creates the `User` row, mirroring the old system's
  `generateEmployeeId.js` — which has a code comment documenting a real
  prior race condition this pattern fixes.
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
npx prisma migrate deploy   # non-interactive; see note below on `migrate dev`
npm run start:dev           # listens on :4000, Swagger at /api/docs
```

Note: `prisma migrate dev` requires an interactive TTY and will refuse to
run in a non-interactive shell. New migrations in this project are
generated with `prisma migrate diff --script` into a manually-named
migration folder, then applied with `migrate deploy` — see the git history
of `prisma/migrations/` for the exact commands used. This also needs a
persistent shadow database (`hrms_v2_shadow`, configured in
`prisma.config.ts`) rather than the one `migrate dev` would normally
create/drop automatically.

## Automated tests

```bash
npm run test       # unit tests
npm run test:e2e   # full flow against a real Postgres DB
```

`test:e2e` needs its own database (kept separate from `hrms_v2_dev` so a
test run never touches data you're looking at in Swagger/curl):

```bash
psql postgres -c "CREATE DATABASE hrms_v2_test OWNER hrms_v2_user;"
DATABASE_URL="postgresql://hrms_v2_user:hrms_v2_pass@localhost:5432/hrms_v2_test?schema=public" npx prisma migrate deploy
```

`.env.test` is checked in — its secrets are dummy/test-only, unlike `.env`.
Each e2e spec truncates its own tables in `afterAll`, so re-running is
safe. `test/auth.e2e-spec.ts` automates register → login → RBAC-across-
all-4-roles → refresh-rotation → logout-revocation → mobile-no-cookie-jar-
refresh.

`src/prisma/tenant-scope.guard-logic.spec.ts` locks in both the guard's
verified operation-name coverage and its one remaining documented boundary
(nested relational writes reached through a different model's
`include`/`connect` aren't visible to it at all) as regression tests
rather than just comments.

## Manual verification

The automated e2e suite above covers the core flow; useful for interactive
exploration via Swagger/curl:

```bash
# 1. Register (creates an ADMIN founder)
curl -s -X POST localhost:4000/auth/register -H 'Content-Type: application/json' \
  -d '{"organizationName":"QA Org","name":"QA Founder","email":"qa@example.test","password":"TestPass123!"}'

# 2. Login
ACCESS=$(curl -s -X POST localhost:4000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"qa@example.test","password":"TestPass123!"}' -c cookies.txt | jq -r .accessToken)

# 3. Create a Department, then an Employee in it (as the ADMIN founder —
#    POST /employees can assign any role, so this is also how to get HR/
#    Manager/Employee test accounts for RBAC testing, no separate seed
#    script needed)
curl -s -X POST localhost:4000/departments -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"name":"Engineering","code":"ENG"}'
curl -s -X POST localhost:4000/employees -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Jane HR","email":"jane@example.test","role":"HR"}'
# response includes { generatedPassword } once — no email delivery yet (see below)

# 4. Exercise RBAC on the organizations proof endpoint
curl -s localhost:4000/organizations/me -H "Authorization: Bearer <accessToken>"
# ADMIN/HR -> 200, MANAGER/EMPLOYEE -> 403

# 5. Refresh (rotates the token) and logout (revokes it)
curl -s -X POST localhost:4000/auth/refresh -b cookies.txt -c cookies.txt
curl -s -X POST localhost:4000/auth/logout -b cookies.txt
```

**Concurrency check** (the specific bug class `employee-id.service.ts` is
meant to prevent) — fire two concurrent `POST /employees` at the same org
and confirm both get distinct, sequential `employeeId`s rather than
colliding:
```bash
curl -s -X POST localhost:4000/employees -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d '{"name":"A","email":"a@example.test"}' &
curl -s -X POST localhost:4000/employees -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d '{"name":"B","email":"b@example.test"}' &
wait
```

To reset the disposable dev database entirely: `npx prisma migrate reset`
(interactive — see the non-interactive note above if this refuses to run;
`psql` a manual `TRUNCATE` instead if so).

## Explicitly out of scope so far

Document upload/review, profile photo upload (no file-storage decision —
R2/S3 — made for backend-v2 yet), `personalData` JSON blob endpoint,
probation decision workflow, role-history/employment-status-history
tracking, employee assets, bulk create, salary structure (a distinct
payroll-domain concern in the old system too). Payroll/Attendance/Leave
modules, data migration from the live MySQL database, Next.js web, mobile
TypeScript, Redis/BullMQ/Resend/R2, Sentry, Super Admin, payments/billing.
