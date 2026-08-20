import { Inject, Injectable } from '@nestjs/common';
import { PayrollSettings, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { RedisCacheService } from '../common/redis-cache';
import { UpdatePayrollSettingsDto } from './dto/update-payroll-settings.dto';
import { resolveDayOfMonth } from './payroll-date';

// Read once per employee inside a payroll batch, rarely written — same
// caching rationale as StatutoryConfigService.getEffective.
const SETTINGS_CACHE_TTL_SECONDS = 300;

/**
 * The canonical accessor for an org's PayrollSettings — mirrors the old
 * system's payrollEngine.js `getPayrollSettings(organizationId)`, which
 * every other module (CompOff, LeaveEncashment, Settlement, ...) called
 * through rather than querying the model directly. Find-or-create: a
 * fresh org has no row until the first read or write.
 */
@Injectable()
export class PayrollSettingsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly cache: RedisCacheService,
  ) {}

  private cacheKey(organizationId: string): string {
    return `payrollsettings:${organizationId}`;
  }

  async getOrCreate(organizationId: string): Promise<PayrollSettings> {
    return this.cache.getOrSet(
      this.cacheKey(organizationId),
      SETTINGS_CACHE_TTL_SECONDS,
      async () => {
        const existing = await this.scopedPrisma.payrollSettings.findFirst({
          where: { organizationId },
        });
        if (existing) return existing;
        return this.scopedPrisma.payrollSettings.create({
          data: { organizationId },
        });
      },
    );
  }

  async getWithResolvedDates(organizationId: string) {
    const settings = await this.getOrCreate(organizationId);
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    return {
      settings,
      resolvedForCurrentMonth: {
        processingDate: resolveDayOfMonth(settings.processingDay, year, month),
        paymentDate: resolveDayOfMonth(settings.paymentDay, year, month),
      },
    };
  }

  async update(
    dto: UpdatePayrollSettingsDto,
    updatedById: string,
    organizationId: string,
  ): Promise<PayrollSettings> {
    await this.getOrCreate(organizationId);
    await this.scopedPrisma.payrollSettings.updateMany({
      where: { organizationId },
      data: {
        ...(dto as unknown as Prisma.PayrollSettingsUpdateManyMutationInput),
        updatedById,
      },
    });
    await this.cache.invalidate(this.cacheKey(organizationId));
    return this.getOrCreate(organizationId);
  }
}
