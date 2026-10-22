// Purpose: Protects the Control Center routes: needs a valid Control Center access token (CcAuthService.verifyAccess).
// Important: the HRMS global guard is switched off for these routes with @Public(); this guard replaces it. An HRMS token
//   cannot pass here (different secret, and no `cc-access` type), so a company user can never reach a Control Center route.
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { SuperAdmin } from '@prisma/client';
import { CcAuthService } from './cc-auth.service';

export type CcRequest = Request & { superAdmin?: SuperAdmin };

@Injectable()
export class CcAuthGuard implements CanActivate {
  constructor(private readonly auth: CcAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CcRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException();
    req.superAdmin = await this.auth.verifyAccess(token);
    return true;
  }
}

export const CurrentSuperAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): SuperAdmin => {
  return ctx.switchToHttp().getRequest<CcRequest>().superAdmin as SuperAdmin;
});
