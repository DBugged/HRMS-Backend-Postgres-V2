import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PayrollSettings, Prisma, StatutoryModule } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { RedisCacheService } from '../common/redis-cache';
import { UpdatePayrollSettingsDto } from './dto/update-payroll-settings.dto';
import { resolveDayOfMonth } from './payroll-date';
import {
  resolveShiftConfig,
  OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isOvertimePayEnabled } from '../overtime/overtime-pay';

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
// The org-level switch on the Payroll Settings screen and the statutory module it controls. A statutory config version
// carries its own isEnabled and, when one is in effect, that is what payroll obeys, so the two must move together.
const STATUTORY_SWITCHES = [
  ['pfEnabled', StatutoryModule.PF],
  ['esiEnabled', StatutoryModule.ESI],
  ['ptEnabled', StatutoryModule.PT],
  ['lwfEnabled', StatutoryModule.LWF],
  ['npsEnabled', StatutoryModule.NPS],
  ['gratuityEnabled', StatutoryModule.GRATUITY],
  ['bonusEnabled', StatutoryModule.BONUS],
] as const;

// A Professional Tax ladder must be a list of {upTo, amount} bands: ascending positive upper bounds, non-negative
// amounts, and only the last (open-ended) band may have upTo = null.
function assertValidPtSlabs(slabs: unknown): void {
  if (!Array.isArray(slabs)) {
    throw new BadRequestException('ptSlabs must be a list of bands.');
  }
  let previous = 0;
  slabs.forEach((band: { upTo?: unknown; amount?: unknown }, index) => {
    const amount = band?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException(
        `ptSlabs band ${index + 1}: amount must be a number of 0 or more.`,
      );
    }
    const upTo = band?.upTo;
    const isLast = index === slabs.length - 1;
    if (upTo === null || upTo === undefined) {
      if (!isLast) {
        throw new BadRequestException(
          `ptSlabs band ${index + 1}: only the last band can be open-ended (upTo empty).`,
        );
      }
      return;
    }
    if (
      typeof upTo !== 'number' ||
      !Number.isFinite(upTo) ||
      upTo <= previous
    ) {
      throw new BadRequestException(
        `ptSlabs band ${index + 1}: upTo must be a number greater than the previous band's.`,
      );
    }
    previous = upTo;
  });
}

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
        // Parallel callers (a bulk payroll run calculates employees concurrently) can all find no row on a new
        // organisation's first run; the unique constraint lets exactly one create win, the rest re-read it.
        let base = existing;
        if (!base) {
          try {
            base = await this.scopedPrisma.payrollSettings.create({
              data: { organizationId },
            });
          } catch (err) {
            if ((err as { code?: string }).code !== 'P2002') throw err;
            base = await this.scopedPrisma.payrollSettings.findFirstOrThrow({
              where: { organizationId },
            });
          }
        }
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
    // Org-wide default weekly-offs — there's no single department to
    // resolve against at this org-settings level, same rationale as
    // resolveShiftConfig's own org-default branch.
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
    });
    const { weeklyOffs } = resolveShiftConfig(
      null,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
    );
    return {
      settings,
      // False when the Overtime Pay salary component is off. The settings screen locks the Overtime Rates then (they
      // feed only that component), and update() below ignores edits to them.
      overtimePayEnabled: await isOvertimePayEnabled(
        this.scopedPrisma,
        organizationId,
      ),
      resolvedForCurrentMonth: {
        processingDate: resolveDayOfMonth(
          settings.processingDay,
          year,
          month,
          weeklyOffs,
        ),
        paymentDate: resolveDayOfMonth(
          settings.paymentDay,
          year,
          month,
          weeklyOffs,
        ),
      },
    };
  }

  async update(
    dto: UpdatePayrollSettingsDto,
    updatedById: string,
    organizationId: string,
  ): Promise<PayrollSettings> {
    const before = await this.getOrCreate(organizationId);
    if (dto.ptSlabs !== undefined) assertValidPtSlabs(dto.ptSlabs);
    // The overtime pay multipliers feed only the Overtime Pay component. While it is off they are locked: the screen
    // sends the whole settings object on every save, so rather than reject a save that merely carries the unchanged
    // rates, any rate in the request is dropped and the stored values are kept for when it is turned back on.
    const effective: UpdatePayrollSettingsDto = { ...dto };
    if (!(await isOvertimePayEnabled(this.scopedPrisma, organizationId))) {
      delete effective.otRegularRate;
      delete effective.otHolidayRate;
      delete effective.otWeekendRate;
      delete effective.otNightRate;
    }
    await this.scopedPrisma.payrollSettings.updateMany({
      where: { organizationId },
      data: {
        ...(effective as unknown as Prisma.PayrollSettingsUpdateManyMutationInput),
        updatedById,
      },
    });
    await this.cache.invalidate(this.cacheKey(organizationId));

    // A switch that was actually flipped carries over to the open-ended statutory version of its module, otherwise the
    // version keeps overriding it and e.g. PF stays off after being turned on here. Switches merely resent unchanged
    // leave a deliberately different version alone.
    for (const [flag, module] of STATUTORY_SWITCHES) {
      const next = effective[flag];
      if (typeof next !== 'boolean' || next === before[flag]) continue;
      await this.scopedPrisma.statutoryConfigVersion.updateMany({
        where: { organizationId, module, effectiveTo: null },
        data: { isEnabled: next },
      });
      await this.cache.invalidatePrefix(
        `statconfig:${organizationId}:${module}:`,
      );
    }

    await this.auditLogService.log({
      actorId: updatedById,
      action: 'PAYROLL_SETTINGS_UPDATED',
      module: 'PAYROLL',
      organizationId,
      // Before/after for every field that actually changed, not just the new values.
      details: {
        ...effective,
        changes: Object.fromEntries(
          Object.entries(effective)
            .filter(
              ([key, value]) =>
                JSON.stringify(value) !==
                JSON.stringify((before as Record<string, unknown>)[key]),
            )
            .map(([key, value]) => [
              key,
              {
                before: (before as Record<string, unknown>)[key],
                after: value,
              },
            ]),
        ),
      },
    });

    return this.getOrCreate(organizationId);
  }
}
