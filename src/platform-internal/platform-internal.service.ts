import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Backs the /internal/* S2S surface the HRMS Control Center calls. Uses the
 * RAW PrismaService (not the tenant-scope-extended client) deliberately —
 * this is the one place in the app meant to read/act across organizations,
 * gated by PlatformS2sGuard rather than a request-scoped tenant context.
 *
 * No customer employee/attendance/payroll data ever crosses this boundary —
 * only the aggregates the Control Center's own usage-metric model accepts
 * (active_users, seats_used) plus the org's own status flags. storage_bytes
 * and api_calls are not tracked anywhere in this system yet; returned as 0
 * rather than fabricated.
 */
@Injectable()
export class PlatformInternalService {
  private readonly logger = new Logger(PlatformInternalService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getOrg(id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
    return {
      id: org.id,
      name: org.name,
      status: org.isActive ? 'ACTIVE' : 'SUSPENDED',
      isActive: org.isActive,
      isInitialized: org.isInitialized,
      employeeCount: org._count.users,
      createdAt: org.createdAt,
    };
  }

  async setOrgStatus(id: string, status: string, reason: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
    const isActive = status !== 'SUSPENDED';
    await this.prisma.organization.update({
      where: { id },
      data: { isActive },
    });
    // No column exists (or should exist here) to persist a Super Admin's
    // suspend reason — that's the Control Center's own record to keep, on
    // its own Organization row. Logged here only for local traceability.
    this.logger.log(
      `Platform status change: org=${id} isActive=${isActive} reason="${reason}"`,
    );
  }

  async getUsage(id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
    const [seatsUsed, activeUsers, lastLogin] = await Promise.all([
      this.prisma.user.count({ where: { organizationId: id } }),
      this.prisma.user.count({ where: { organizationId: id, isActive: true } }),
      this.prisma.user.aggregate({
        where: { organizationId: id },
        _max: { lastLoginAt: true },
      }),
    ]);
    return {
      active_users: activeUsers,
      seats_used: seatsUsed,
      storage_bytes: 0,
      api_calls: 0,
      last_active_at: lastLogin._max.lastLoginAt?.toISOString() ?? null,
    };
  }
}
