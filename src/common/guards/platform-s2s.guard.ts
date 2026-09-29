import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Authenticates the platform-level S2S endpoints under /internal/* — called
 * by the separate HRMS Control Center (its own DB, own Super Admin auth),
 * never by a browser or an org's own JWT. Deliberately NOT the same guard
 * chain as everything else: these routes are @Public() (exempt from
 * JwtAuthGuard/PasswordRotationGuard) and rely solely on this shared-secret
 * check, mirroring the existing face-api-key webhook pattern but as a single
 * platform-wide secret rather than a per-org one, since there is no
 * per-request tenant context here — the caller supplies the org id itself.
 */
@Injectable()
export class PlatformS2sGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.PLATFORM_S2S_TOKEN;
    if (!expected) {
      // Fail closed: an unset secret must never mean "anyone can call this."
      throw new ServiceUnavailableException(
        'PLATFORM_S2S_TOKEN is not configured.',
      );
    }
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    const ok =
      a.length === b.length && provided.length > 0 && timingSafeEqual(a, b);
    if (!ok) throw new UnauthorizedException('Invalid platform credential.');
    return true;
  }
}
