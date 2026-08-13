import { Prisma } from '@prisma/client';
import { evaluateTenantScope } from './tenant-scope.guard-logic';

/**
 * Replicates the old MySQL/Sequelize backend's `enforceTenantScope` hooks:
 * throw at runtime if a query against a tenant-owned model is missing an
 * `organizationId` filter, rather than relying purely on every service
 * remembering to add one. This was the single biggest quiet strength found
 * in the architecture audit of the old system — losing it during migration
 * would be a real regression, not a wash.
 *
 * This is a thin Prisma Client Extension adapter — the actual decision
 * logic lives in tenant-scope.guard-logic.ts (evaluateTenantScope), kept
 * separate specifically so it's unit-testable against plain objects
 * without needing a live Prisma client. See that file's tests for the
 * behavior this enforces, including the documented nested-write boundary.
 */
export function tenantScopeExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'tenant-scope-guard',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const cleanedArgs = evaluateTenantScope(model, operation, args);
            return query(cleanedArgs);
          },
        },
      },
    }),
  );
}
