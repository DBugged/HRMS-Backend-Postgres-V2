import { Inject, Injectable } from '@nestjs/common';
import { PayrollSettings, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { RedisCacheService } from '../common/redis-cache';
import { UpdatePayrollSettingsDto } from './dto/update-payroll-settings.dto';
import { resolveDayOfMonth } from './payroll-date';
import { AuditLogService } from '../audit-log/audit-log.service';

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
    private readonly auditLogService: AuditLogService,
  ) {}

  private cacheKey(organizationId: string): string {
    return `payrollsettings:${organizationId}`;
  }

  // financialYearStartMonth/currency/currencySymbol live on PayrollSettings
  // as columns (payroll math and the payslip PDF read a plain object, not
  // two joined tables), but Organization Settings > Policies is their
  // actual source of truth — the same fields the rest of the app (web +
  // mobile currency symbol, Setup Wizard) reads. Overlaying them here,
  // once, on every read is what keeps a change in Policies from silently
  // failing to reach real payroll calculations.
  async getOrCreate(organizationId: string): Promise<PayrollSettings> {
    return this.cache.getOrSet(
      this.cacheKey(organizationId),
      SETTINGS_CACHE_TTL_SECONDS,
      async () => {
        const [existing, org] = await Promise.all([
          this.scopedPrisma.payrollSettings.findFirst({
            where: { organizationId },
          }),
          this.scopedPrisma.organization.findFirst({
            where: { id: organizationId },
            select: { policies: true },
          }),
        ]);
        const base =
          existing ??
          (await this.scopedPrisma.payrollSettings.create({
            data: { organizationId },
          }));
        const policies = (org?.policies as Record<string, unknown>) || {};
        return {
          ...base,
          currency: (policies.currency as string) || base.currency,
          currencySymbol:
            (policies.currencySymbol as string) || base.currencySymbol,
          financialYearStartMonth:
            Number(policies.financialYearStartMonth) ||
            base.financialYearStartMonth,
        };
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

    await this.auditLogService.log({
      actorId: updatedById,
      action: 'PAYROLL_SETTINGS_UPDATED',
      module: 'PAYROLL',
      organizationId,
      details: { ...dto },
    });

    return this.getOrCreate(organizationId);
  }
}
