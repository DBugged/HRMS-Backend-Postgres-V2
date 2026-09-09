import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../decorators/allow-pending-password-change.decorator';

/**
 * Enforces the mustChangePassword gate server-side.
 *
 * Every new employee is created with a generated temporary password and
 * User.mustChangePassword = true. Both clients show a blocking
 * force-password-change screen for that flag — but that was the ONLY
 * thing enforcing it. The login response for such an account carries a
 * fully-privileged access token, so anyone holding the emailed temporary
 * password could skip the screen and drive the entire API with it
 * indefinitely (confirmed against /auth/me, /leaves, /attendance and
 * /payroll). Since those temporary passwords travel by email and are
 * frequently reused or forwarded, treating the gate as advisory is the
 * weakest link in the auth chain.
 *
 * Registered globally (see app.module.ts). @Public() routes are exempt —
 * they have no authenticated user to check — and @AllowPendingPasswordChange()
 * marks the handful of routes the rotation screen itself needs.
 */
@Injectable()
export class PasswordRotationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PENDING_PASSWORD_CHANGE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as User | undefined;
    // No user means JwtAuthGuard already rejected this; defensive only.
    if (!user || !user.mustChangePassword) return true;

    throw new ForbiddenException(
      'Set a new password before continuing — your account is still on a temporary password.',
    );
  }
}
