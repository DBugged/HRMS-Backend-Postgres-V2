// Purpose: Per-route permission check for Control Center routes, e.g. @CcPermission('organizations:read').
// Important: runs after CcAuthGuard (which sets req.superAdmin); uses the same role->permission map the panel reads.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleHas } from './cc-permissions';
import type { CcRequest } from './cc-auth.guard';

const KEY = 'cc-permission';
export const CcPermission = (permission: string) => SetMetadata(KEY, permission);

@Injectable()
export class CcPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const needed = this.reflector.getAllAndOverride<string | undefined>(KEY, [context.getHandler(), context.getClass()]);
    if (!needed) return true;
    const admin = context.switchToHttp().getRequest<CcRequest>().superAdmin;
    if (!admin || !roleHas(admin.role, needed)) throw new ForbiddenException('You do not have permission to do this.');
    return true;
  }
}
