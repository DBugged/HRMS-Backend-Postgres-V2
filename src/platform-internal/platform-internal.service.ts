import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { forgetOrganizationStatus } from '../common/org-status';

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
      status: org.platformStatus,
      isActive: org.isActive,
      isInitialized: org.isInitialized,
      employeeCount: org._count.users,
      createdAt: org.createdAt,
    };
  }

  async setOrgStatus(id: string, status: string, reason: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
    // SUSPENDED and ARCHIVED switch the organisation off; ACTIVE and PENDING leave it usable. (Before, only
    // SUSPENDED did - ARCHIVED silently re-activated the organisation - and nothing in the app read the flag.)
    const isActive = status === 'ACTIVE' || status === 'PENDING';
    await this.prisma.organization.update({
      where: { id },
      data: { isActive, platformStatus: status },
    });
    forgetOrganizationStatus(id);
    // Recorded in the organisation's own audit log, attributed to its founder account with the actor role
    // PLATFORM - the audit table needs a user, and the role marks it as a platform action, not theirs.
    const founder =
      (await this.prisma.user.findFirst({
        where: { organizationId: id, isFounder: true },
        select: { id: true },
      })) ??
      (await this.prisma.user.findFirst({
        where: { organizationId: id, role: 'ADMIN' },
        select: { id: true },
      }));
    if (founder) {
      await this.prisma.auditLog.create({
        data: {
          organizationId: id,
          actorId: founder.id,
          actorRole: 'PLATFORM',
          action: 'PLATFORM_ORG_STATUS_CHANGED',
          module: 'EMPLOYEE',
          details: {
            source: 'platform_s2s',
            from: org.platformStatus,
            to: status,
            reason,
          },
        },
      });
    }
    this.logger.log(
      `Platform status change: org=${id} status=${status} isActive=${isActive} reason="${reason}"`,
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
