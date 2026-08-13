import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { tenantScopeExtension } from './tenant-scope.extension';

// Token for the tenant-scope-guarded client. $extends() returns a *new*
// client instance rather than mutating PrismaService in place, so services
// that touch tenant-scoped models (User, RefreshToken) inject this token;
// PrismaService itself is still exported directly for Organization queries
// and connection lifecycle.
export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

// Prisma's own ReturnType<PrismaClient['$extends']> doesn't resolve
// cleanly (the method is generically overloaded) — aliasing to the base
// PrismaClient type instead is a known, pragmatic workaround: the extended
// client has the exact same model delegate methods at the type level, it
// just also runs the tenant-scope guard at runtime. The one thing this
// alias can't type-check is the extension's custom `__tenantScopeBypass`
// argument — those specific call sites cast explicitly, see
// UsersService.findByEmail for the pattern.
export type ExtendedPrismaClient = PrismaClient;

@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: PRISMA_CLIENT,
      useFactory: (prisma: PrismaService) =>
        prisma.$extends(tenantScopeExtension()),
      inject: [PrismaService],
    },
  ],
  exports: [PrismaService, PRISMA_CLIENT],
})
export class PrismaModule {}
