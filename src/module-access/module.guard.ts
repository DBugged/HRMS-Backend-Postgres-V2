// Purpose: refuses requests to a module the company's Super Admin has switched off (Control Panel > Organization > Features).
// Important: runs after JwtAuthGuard (needs req.user). Public routes and Control Center routes have no company user, so they pass.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { ModuleAccessService } from './module-access.service';
import { MODULE_LABELS, moduleForPath } from './module-routes';

@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(private readonly access: ModuleAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as User | undefined;
    if (!user?.organizationId) return true;
    const module = moduleForPath(req.path);
    if (!module) return true;
    if (!(await this.access.disabledFor(user.organizationId)).has(module)) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: 'MODULE_DISABLED',
      message: `${MODULE_LABELS[module] ?? 'This module'} is not enabled for your company. Please contact support to turn it on.`,
    });
  }
}
