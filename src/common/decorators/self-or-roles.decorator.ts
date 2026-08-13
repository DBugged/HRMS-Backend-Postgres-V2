import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

export const SELF_OR_ROLES_KEY = 'selfOrRoles';

export interface SelfOrRolesMeta {
  roles: Role[];
  // Name of the route param holding the target user's id, e.g. 'id' for a
  // route like GET /users/:id.
  paramKey: string;
}

/**
 * The self-or-role pattern the old backend reimplemented ad hoc in
 * multiple controllers (e.g. "employee can view their own record, or an
 * HR/Manager can view anyone's") instead of sharing one helper. This
 * decorator + RolesGuard's handling of SELF_OR_ROLES_KEY is the single
 * reusable version: allowed if the caller's role is in `roles`, OR the
 * route param at `paramKey` equals the caller's own id.
 */
export const SelfOrRoles = (paramKey: string, ...roles: Role[]) =>
  SetMetadata(SELF_OR_ROLES_KEY, { roles, paramKey });
