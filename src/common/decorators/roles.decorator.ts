import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the given roles. This is one half of the RBAC
 * consolidation for this project: the old backend had role checks scattered
 * across 8+ route files as hardcoded literal arrays, some importing shared
 * constants and some not. Here there is exactly one mechanism — this
 * decorator plus RolesGuard — so a new module never has to reinvent
 * authorization logic per-controller.
 *
 * Adding a future Super Admin role only ever means: (1) add SUPER_ADMIN to
 * the Prisma Role enum + one migration, and (2) either add it to the
 * relevant @Roles(...) call sites, or add a single short-circuit in
 * RolesGuard so it always passes — see roles.guard.ts.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
