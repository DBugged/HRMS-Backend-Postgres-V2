import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  SELF_OR_ROLES_KEY,
  SelfOrRolesMeta,
} from '../decorators/self-or-roles.decorator';

/**
 * Single guard handling both RBAC patterns used across this project:
 *   - @Roles(...roles)               -> allowed only if user.role is listed
 *   - @SelfOrRoles(paramKey, ...roles) -> allowed if user.role is listed,
 *                                         OR the :paramKey route param
 *                                         equals the caller's own id
 * If neither decorator is present, the route only requires authentication
 * (handled by JwtAuthGuard upstream) with no further restriction — matches
 * routes like GET /auth/me in the old system.
 *
 * Runs after JwtAuthGuard, which populates request.user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      string[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    const selfOrRoles = this.reflector.getAllAndOverride<
      SelfOrRolesMeta | undefined
    >(SELF_OR_ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles && !selfOrRoles) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as User | undefined;
    if (!user) return false; // JwtAuthGuard should have already rejected this; defensive only.

    // Future Super Admin: uncomment once the role exists on the Prisma enum —
    // a single line here grants every @Roles()/@SelfOrRoles() gated route
    // without touching any of their call sites individually.
    // if (user.role === Role.SUPER_ADMIN) return true;

    if (requiredRoles?.includes(user.role)) return true;

    if (selfOrRoles) {
      if (selfOrRoles.roles.includes(user.role)) return true;
      const targetId = request.params?.[selfOrRoles.paramKey];
      if (targetId && targetId === user.id) return true;
    }

    throw new ForbiddenException(
      'You do not have permission to perform this action.',
    );
  }
}
