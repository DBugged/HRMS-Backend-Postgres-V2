/**
 * Pure decision logic for the tenant-scope guard, extracted from
 * tenant-scope.extension.ts so it can be unit-tested directly against
 * plain objects instead of through Prisma's `$extends`/`$allOperations`
 * harness (which requires a live client to exercise at all). The
 * extension itself is a thin adapter that just calls this function and
 * forwards to Prisma's `query(args)`.
 *
 * The operation-name sets below are checked against the ACTUAL generated
 * client's delegate methods (empirically listed via
 * `Object.getOwnPropertyNames(prisma.user)`, not guessed from naming
 * patterns) — Prisma 7's generated types don't expose a simple static
 * operation-name union to grep, and two invented names (`updateOrThrow`,
 * `deleteOrThrow`) turned out not to exist when checked this way. Real
 * list: aggregate, aggregateRaw, count, create, createMany,
 * createManyAndReturn, delete, deleteMany, findFirst, findFirstOrThrow,
 * findMany, findRaw, findUnique, findUniqueOrThrow, groupBy, update,
 * updateMany, updateManyAndReturn, upsert.
 */

export const TENANT_SCOPED_MODELS = new Set([
  'User',
  'RefreshToken',
  'Department',
  'Holiday',
  'WorkLocation',
  'LeaveType',
  'LeaveBalance',
  'Leave',
  'CompOff',
  'SalaryComponent',
  'PayrollSettings',
  'EmployeeSalaryComponent',
  'PayrollTemplate',
  'StatutoryConfigVersion',
  'EmployeeTaxDeclaration',
  'TaxSlabConfig',
  'Punch',
  'Attendance',
  'AttendanceImportBatch',
  'OvertimeRecord',
  'PerformanceRating',
  'LeaveEncashment',
  'PayrollRun',
  'Reimbursement',
  'Loan',
  'LoanRepayment',
  'Settlement',
  'OffboardingCase',
  'AuditLog',
  'EmployeeTimeline',
  'ApprovalDelegation',
  'PolicyDocument',
  'DocumentRequirement',
  'Notification',
  'EmployeeDocument',
  'EmployeeAsset',
  'EmployeeRoleHistory',
  'EmploymentStatusHistory',
  'EmailTemplate',
  'OrgListItem',
  'WorkSchedule',
]);

// Operations whose `where` accepts arbitrary filters (so organizationId
// can always be added to it) — findFirstOrThrow behaves like findFirst
// here (arbitrary where, just throws instead of returning null), and
// aggregate/groupBy both take a top-level `where` the same shape as
// findMany's. *AndReturn variants are the "Many" ops' row-returning
// siblings, same where-shape.
const FILTERED_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);
const CREATE_OPS = new Set(['create']);
const CREATE_MANY_OPS = new Set(['createMany', 'createManyAndReturn']);
// findUnique/findUniqueOrThrow/update/delete/upsert all take a *unique-
// constraint* `where` (id, email, ...) — you cannot additionally require
// organizationId there the way you can with findFirst/updateMany/
// deleteMany. This mirrors the old tenantScope.js's documented `findByPk`
// limitation: rather than silently allow an unscoped single-record lookup/
// write, forbid it outright and point callers at the pattern that IS
// covered (findFirst/updateMany/deleteMany with `where: { id,
// organizationId }`).
//
// This set originally only had the two find* ops — update/delete/upsert
// were added after they were caught (during Employees module development)
// slipping through the guard entirely: neither FILTERED_OPS nor this set
// covered them, so a bare `prisma.user.update({ where: { id }, data })`
// ran completely unchecked. Same bug class as the boundary already
// documented below (something the guard doesn't cover) — the difference
// is this one was closable, so it was closed rather than just documented.
export const FORBIDDEN_UNIQUE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

export interface ScopedArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  __tenantScopeBypass?: boolean;
}

/**
 * Returns the args to actually run the query with (bypass flag stripped),
 * or throws if the query violates tenant scoping. `model`/`operation`
 * follow Prisma's `$allOperations` callback shape (model is undefined for
 * raw queries, which this function passes through untouched since they
 * aren't part of `TENANT_SCOPED_MODELS`).
 *
 * KNOWN BOUNDARY (documented, not silently papered over — see
 * tenant-scope.guard-logic.spec.ts's "nested writes" test for the exact
 * shape of what this does NOT catch): this only evaluates top-level model
 * calls. A nested relational write reached through a different model's
 * include/connect (e.g. organization.update({ data: { users: { updateMany:
 * {...} } } })) is not guaranteed to surface here as a top-level
 * User.updateMany call — it never reaches this function at all, because
 * Prisma's extension `$allOperations` hook only fires for operations
 * invoked directly on a model's own delegate (`prisma.user.updateMany(...)`),
 * not for relational sub-operations nested inside another model's write.
 * This phase has no such nested writes anywhere in the codebase; future
 * modules must not assume 100% coverage without checking.
 */
export function evaluateTenantScope(
  model: string | undefined,
  operation: string,
  args: ScopedArgs,
): ScopedArgs {
  if (!model || !TENANT_SCOPED_MODELS.has(model)) {
    return args;
  }

  // Narrow, explicit escape hatch — mirrors the old system's
  // `tenantScopeBypass: true`. Only legitimate use: resolving a tenant from
  // a globally-unique column before the caller knows which organization
  // they're in (email lookup at login/registration, opaque-token lookup at
  // refresh/logout). Stripped before the real query runs so it never
  // reaches the Prisma client itself.
  if (args.__tenantScopeBypass === true) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the flag deliberately
    const { __tenantScopeBypass, ...rest } = args;
    return rest;
  }

  if (FORBIDDEN_UNIQUE_OPS.has(operation)) {
    throw new Error(
      `${model}.${operation}: not allowed on a tenant-scoped model — Prisma can't combine a ` +
        `unique-id lookup with an organizationId filter here. Use findFirst/updateMany/` +
        `deleteMany with { where: { id, organizationId } } instead.`,
    );
  }

  if (FILTERED_OPS.has(operation)) {
    if (!args.where || !('organizationId' in args.where)) {
      throw new Error(
        `${model}.${operation}: query missing organizationId scope. Pass { where: { ` +
          `organizationId, ... } }, or use __tenantScopeBypass for a deliberate ` +
          `tenant-resolution lookup.`,
      );
    }
  }

  if (CREATE_OPS.has(operation)) {
    const data = args.data as Record<string, unknown> | undefined;
    if (!data?.organizationId) {
      throw new Error(
        `${model}.create: missing organizationId on the created row.`,
      );
    }
  }

  if (CREATE_MANY_OPS.has(operation)) {
    const rows = Array.isArray(args.data) ? args.data : [args.data];
    if (rows.some((row) => !row?.organizationId)) {
      throw new Error(
        `${model}.${operation}: every row must set organizationId.`,
      );
    }
  }

  return args;
}
