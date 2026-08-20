// Purpose: Minimal user-lookup helpers backing AuthService — email/reset-token lookup and last-login stamping.
// Responsibilities: Owns the two legitimate tenant-scope-bypass lookups (findByEmail, findByResetToken) used
// only where the organization is genuinely unknown yet; everything else is normal organizationId-scoped.
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

// Deliberately thin — this phase only needs enough to support Auth.
// A real Employees module (profile fields, org-wide listing, etc.) is a
// later phase; this is not a placeholder to build out prematurely.
@Injectable()
export class UsersService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
  ) {}

  /**
   * Tenant-unknown lookup — the one legitimate use of the bypass, mirrors
   * the old system's login/registration email checks. `__tenantScopeBypass`
   * isn't part of Prisma's generated arg types (it's read and stripped by
   * tenant-scope.extension.ts before the real query runs), so this is the
   * one place in the service that needs an explicit cast rather than a
   * class-wide `any` — the cast documents exactly where the bypass is used
   * instead of hiding it.
   */
  findByEmail(email: string): Promise<User | null> {
    // Prisma's generated findFirst arg type has a `[key: string]: never`
    // excess-property guard, so `__tenantScopeBypass` (read and stripped
    // by tenant-scope.extension.ts before the real query runs — it isn't
    // a real Prisma option) can't be added via a plain intersection; the
    // through-unknown cast is the deliberate, narrow escape hatch for
    // exactly this one extension-only field, not a general `any` typing.
    type FindFirstArgs = Parameters<typeof this.prisma.user.findFirst>[0];
    const args = {
      where: { email },
      __tenantScopeBypass: true,
    } as unknown as FindFirstArgs;
    return this.prisma.user.findFirst(args);
  }

  // A reset-token hash alone identifies the account — same tenant-unknown
  // reasoning as findByEmail above.
  findByResetToken(tokenHash: string): Promise<User | null> {
    type FindFirstArgs = Parameters<typeof this.prisma.user.findFirst>[0];
    const args = {
      where: { resetPasswordToken: tokenHash },
      __tenantScopeBypass: true,
    } as unknown as FindFirstArgs;
    return this.prisma.user.findFirst(args);
  }

  findByIdInOrg(id: string, organizationId: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, organizationId } });
  }

  updateLastLogin(
    id: string,
    organizationId: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.user.updateMany({
      where: { id, organizationId },
      data: { lastLoginAt: new Date() },
    });
  }
}
