import { Prisma } from '@prisma/client';

/**
 * Replicates the old MySQL/Sequelize backend's `enforceTenantScope` hooks:
 * throw at runtime if a query against a tenant-owned model is missing an
 * `organizationId` filter, rather than relying purely on every service
 * remembering to add one. This was the single biggest quiet strength found
 * in the architecture audit of the old system — losing it during migration
 * would be a real regression, not a wash.
 *
 * `Organization` itself is deliberately NOT in this list: it IS the tenant,
 * not owned by one, and is scoped by its own `id` directly in service code.
 */
const TENANT_SCOPED_MODELS = new Set(['User', 'RefreshToken']);

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
const FORBIDDEN_UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow']);

interface ScopedArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  __tenantScopeBypass?: boolean;
}

export function tenantScopeExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'tenant-scope-guard',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || !TENANT_SCOPED_MODELS.has(model)) {
              return query(args);
            }

            const scopedArgs = args as ScopedArgs;

            // Narrow, explicit escape hatch — mirrors the old system's
            // `tenantScopeBypass: true`. Only legitimate use: resolving a
            // tenant from a globally-unique column before the caller knows
            // which organization they're in (email lookup at login/
            // registration). Stripped before the real query runs so it
            // never reaches the Prisma client itself.
            if (scopedArgs.__tenantScopeBypass === true) {
              delete scopedArgs.__tenantScopeBypass;
              return query(args);
            }

            if (FORBIDDEN_UNIQUE_OPS.has(operation)) {
              throw new Error(
                `${model}.${operation}: not allowed on a tenant-scoped model — Prisma can't ` +
                  `combine a unique-id lookup with an organizationId filter here. Use ` +
                  `findFirst({ where: { id, organizationId } }) instead.`,
              );
            }

            if (FILTERED_OPS.has(operation)) {
              if (
                !scopedArgs.where ||
                !('organizationId' in scopedArgs.where)
              ) {
                throw new Error(
                  `${model}.${operation}: query missing organizationId scope. Pass ` +
                    `{ where: { organizationId, ... } }, or use __tenantScopeBypass for a ` +
                    `deliberate tenant-resolution lookup.`,
                );
              }
            }

            if (CREATE_OPS.has(operation)) {
              const data = scopedArgs.data as
                Record<string, unknown> | undefined;
              if (!data?.organizationId) {
                throw new Error(
                  `${model}.create: missing organizationId on the created row.`,
                );
              }
            }

            if (CREATE_MANY_OPS.has(operation)) {
              const rows = Array.isArray(scopedArgs.data)
                ? scopedArgs.data
                : [scopedArgs.data];
              if (rows.some((row) => !row?.organizationId)) {
                throw new Error(
                  `${model}.createMany: every row must set organizationId.`,
                );
              }
            }

            // KNOWN BOUNDARY (documented, not silently papered over): this
            // extension intercepts top-level model calls only. A nested
            // relational write reached through a different model's
            // include/connect (e.g. organization.update({ data: { users:
            // { updateMany: {...} } } })) is not guaranteed to surface here
            // as a top-level User.updateMany call. This phase has no such
            // nested writes, but future modules must not assume 100%
            // coverage without checking — flag in code review instead.
            return query(args);
          },
        },
      },
    }),
  );
}
