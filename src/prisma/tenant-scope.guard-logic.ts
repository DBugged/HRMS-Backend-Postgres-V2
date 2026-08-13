/**
 * Pure decision logic for the tenant-scope guard, extracted from
 * tenant-scope.extension.ts so it can be unit-tested directly against
 * plain objects instead of through Prisma's `$extends`/`$allOperations`
 * harness (which requires a live client to exercise at all). The
 * extension itself is a thin adapter that just calls this function and
 * forwards to Prisma's `query(args)`.
 */

export const TENANT_SCOPED_MODELS = new Set(['User', 'RefreshToken']);

const FILTERED_OPS = new Set([
  'findMany',
  'findFirst',
  'count',
  'updateMany',
  'deleteMany',
]);
const CREATE_OPS = new Set(['create']);
const CREATE_MANY_OPS = new Set(['createMany']);
// Prisma's findUnique/findUniqueOrThrow can only take unique-constraint
// fields (id, email, ...) in `where` — you cannot additionally require
// organizationId there the way you can with findFirst. This mirrors the old
// tenantScope.js's documented `findByPk` limitation: rather than silently
// allow an unscoped lookup, forbid it outright and point callers at the
// pattern that IS covered (findFirst({ where: { id, organizationId } })).
export const FORBIDDEN_UNIQUE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
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
        `unique-id lookup with an organizationId filter here. Use findFirst({ where: { id, ` +
        `organizationId } }) instead.`,
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
        `${model}.createMany: every row must set organizationId.`,
      );
    }
  }

  return args;
}
