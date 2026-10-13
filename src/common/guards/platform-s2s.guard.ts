import { createHash, timingSafeEqual } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Authenticates the platform-level S2S endpoints under /internal/* — called
 * by the separate HRMS Control Center (its own DB, own Super Admin auth),
 * never by a browser or an org's own JWT. Deliberately NOT the same guard
 * chain as everything else: these routes are @Public() (exempt from
 * JwtAuthGuard/PasswordRotationGuard) and rely on this check alone, mirroring
 * the existing face-api-key webhook pattern but as a single platform-wide
 * secret rather than a per-org one, since there is no per-request tenant
 * context here — the caller supplies the org id itself.
 *
 * Controls, all fail-closed:
 *  - PLATFORM_S2S_TOKEN must be configured (unset = 503, never "open").
 *  - PLATFORM_S2S_TOKEN_PREVIOUS (optional) is accepted too, so the secret can be rotated without downtime: set the
 *    new one, move the old one to _PREVIOUS, update the Control Center, then drop _PREVIOUS.
 *  - PLATFORM_S2S_ALLOWED_IPS (optional, comma-separated) restricts the caller's address. Behind a proxy set
 *    TRUST_PROXY so req.ip is the real caller.
 * Credentials are compared as SHA-256 digests in constant time, so neither content nor length leaks.
 */
const digest = (v: string) => createHash('sha256').update(v).digest();

export function platformCredentialMatches(
  provided: string,
  candidates: (string | undefined)[],
): boolean {
  if (!provided) return false;
  const p = digest(provided);
  // Every candidate is compared (no early exit) so timing does not reveal which one matched.
  let ok = false;
  for (const c of candidates) {
    if (c && timingSafeEqual(p, digest(c))) ok = true;
  }
  return ok;
}

export function ipAllowed(
  ip: string | undefined,
  allowlist: string | undefined,
): boolean {
  const allowed = (allowlist ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  // IPv4-mapped IPv6 ("::ffff:10.0.0.5") is the same address as its IPv4 form.
  const normalized = (ip ?? '').replace(/^::ffff:/, '');
  return allowed.includes(normalized);
}

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
    if (!ipAllowed(request.ip, process.env.PLATFORM_S2S_ALLOWED_IPS)) {
      throw new ForbiddenException('Caller address is not allowed.');
    }
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const ok = platformCredentialMatches(provided, [
      expected,
      process.env.PLATFORM_S2S_TOKEN_PREVIOUS,
    ]);
    if (!ok) throw new UnauthorizedException('Invalid platform credential.');
    return true;
  }
}
