// Purpose: CRUD for per-financial-year, per-regime TaxSlabConfig rows (slabs, standard deduction, cess,
// surcharge, 87A rebate) that PayrollService.calculatePayroll's tax engine reads.
// Responsibilities: Owns upsert-by-(financialYear, regime) and exposes getDefaults() (static slab data,
// not persisted) for the frontend to pre-fill a new config.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaxRegime, TaxSlabConfig } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertTaxSlabDto } from './dto/upsert-tax-slab.dto';
import { getDefaultTaxSlabConfig } from './default-tax-slabs';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { wrapAll } from '../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';

type Band = { from: number; to: number | null; rate: number };

// A slab list must be ordered, non-overlapping bands: each starts at or after the previous band's end, `to` is
// above `from`, rates are 0-100 and only the last band may be open-ended. Overlapping bands are double-counted by
// the engine, and a bad rate silently mis-states every employee's TDS.
function assertValidBands(label: string, bands: unknown): void {
  if (!Array.isArray(bands)) {
    throw new BadRequestException(`${label} must be a list of bands.`);
  }
  let previousEnd = 0;
  (bands as Band[]).forEach((b, i) => {
    const n = i + 1;
    if (typeof b?.from !== 'number' || !Number.isFinite(b.from) || b.from < 0) {
      throw new BadRequestException(
        `${label} band ${n}: "from" must be 0 or more.`,
      );
    }
    if (typeof b.rate !== 'number' || b.rate < 0 || b.rate > 100) {
      throw new BadRequestException(
        `${label} band ${n}: rate must be between 0 and 100.`,
      );
    }
    if (b.from < previousEnd) {
      throw new BadRequestException(
        `${label} band ${n}: overlaps the previous band.`,
      );
    }
    if (b.to === null || b.to === undefined) {
      if (i !== bands.length - 1) {
        throw new BadRequestException(
          `${label} band ${n}: only the last band can be open-ended.`,
        );
      }
      return;
    }
    if (typeof b.to !== 'number' || b.to <= b.from) {
      throw new BadRequestException(
        `${label} band ${n}: "to" must be greater than "from".`,
      );
    }
    previousEnd = b.to;
  });
}

@Injectable()
export class TaxSlabsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  getDefaults(regime: TaxRegime) {
    return getDefaultTaxSlabConfig(regime);
  }

  async findAll(financialYear: string | undefined, organizationId: string) {
    const data = await this.scopedPrisma.taxSlabConfig.findMany({
      where: { organizationId, ...(financialYear && { financialYear }) },
      orderBy: [{ financialYear: 'desc' }, { regime: 'asc' }],
    });
    return wrapAll(data);
  }

  // Registration-time seed: a slab set for BOTH regimes for the current financial year. Payroll silently skips
  // income tax for an employee whose FY/regime has no slab config, and an employee with no declaration defaults
  // to the NEW regime — so an org that only ever configured one regime was quietly under-withholding TDS.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    // The FY start month is a PayrollSettings default (April) at registration — no row exists yet.
    const financialYear = getFinancialYear(
      now.getMonth() + 1,
      now.getFullYear(),
      4,
    );
    for (const regime of [TaxRegime.NEW, TaxRegime.OLD]) {
      const d = getDefaultTaxSlabConfig(regime);
      await tx.taxSlabConfig.create({
        data: {
          organizationId,
          financialYear,
          regime,
          slabs: d.slabs as unknown as Prisma.InputJsonValue,
          standardDeduction: d.standardDeduction,
          cessRate: d.cessRate,
          surchargeSlabs: d.surchargeSlabs as unknown as Prisma.InputJsonValue,
          rebate87ALimit: d.rebate87ALimit,
          rebate87AAmount: d.rebate87AAmount,
        },
      });
    }
  }

  // Slabs of a financial year that already has a locked or paid payroll run can't be changed in place: those payslips
  // were computed from them and would silently stop matching the configuration.
  private async assertFinancialYearNotFinalized(
    financialYear: string,
    organizationId: string,
  ) {
    const finalized = await this.scopedPrisma.payrollRun.findFirst({
      where: {
        organizationId,
        financialYear,
        status: { in: ['LOCKED', 'PAID'] },
      },
      select: { id: true },
    });
    if (finalized) {
      throw new BadRequestException(
        `Payroll for FY ${financialYear} is already locked or paid, so its tax slabs can no longer be changed. Unlock the affected payroll first.`,
      );
    }
  }

  async upsert(
    dto: UpsertTaxSlabDto,
    organizationId: string,
    actorId?: string,
  ) {
    if (dto.slabs !== undefined) assertValidBands('slabs', dto.slabs);
    if (dto.surchargeSlabs !== undefined) {
      assertValidBands('surchargeSlabs', dto.surchargeSlabs);
    }
    for (const [field, value] of [
      ['cessRate', dto.cessRate],
      ['standardDeduction', dto.standardDeduction],
      ['rebate87ALimit', dto.rebate87ALimit],
      ['rebate87AAmount', dto.rebate87AAmount],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new BadRequestException(`${field} must be 0 or more.`);
      }
    }
    if (dto.cessRate !== undefined && dto.cessRate > 100) {
      throw new BadRequestException('cessRate must be between 0 and 100.');
    }
    const existing = await this.scopedPrisma.taxSlabConfig.findFirst({
      where: {
        organizationId,
        financialYear: dto.financialYear,
        regime: dto.regime,
      },
    });
    await this.assertFinancialYearNotFinalized(
      dto.financialYear,
      organizationId,
    );

    const data = {
      ...(dto.slabs !== undefined && {
        slabs: dto.slabs as Prisma.InputJsonValue,
      }),
      ...(dto.standardDeduction !== undefined && {
        standardDeduction: dto.standardDeduction,
      }),
      ...(dto.cessRate !== undefined && { cessRate: dto.cessRate }),
      ...(dto.surchargeSlabs !== undefined && {
        surchargeSlabs: dto.surchargeSlabs as Prisma.InputJsonValue,
      }),
      ...(dto.rebate87ALimit !== undefined && {
        rebate87ALimit: dto.rebate87ALimit,
      }),
      ...(dto.rebate87AAmount !== undefined && {
        rebate87AAmount: dto.rebate87AAmount,
      }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };

    let result: TaxSlabConfig;
    if (existing) {
      await this.scopedPrisma.taxSlabConfig.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      result = await this.scopedPrisma.taxSlabConfig.findFirstOrThrow({
        where: { id: existing.id, organizationId },
      });
    } else {
      result = await this.scopedPrisma.taxSlabConfig.create({
        data: {
          organizationId,
          financialYear: dto.financialYear,
          regime: dto.regime,
          ...data,
        },
      });
    }

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: existing ? 'TAX_SLAB_UPDATED' : 'TAX_SLAB_CREATED',
        module: 'PAYROLL',
        organizationId,
        targetId: result.id,
        details: {
          financialYear: dto.financialYear,
          regime: dto.regime,
          // Before/after of what this save actually changed.
          before: existing
            ? {
                slabs: existing.slabs,
                standardDeduction: existing.standardDeduction,
                cessRate: existing.cessRate,
                surchargeSlabs: existing.surchargeSlabs,
                rebate87ALimit: existing.rebate87ALimit,
                rebate87AAmount: existing.rebate87AAmount,
                isActive: existing.isActive,
              }
            : null,
          after: {
            slabs: result.slabs,
            standardDeduction: result.standardDeduction,
            cessRate: result.cessRate,
            surchargeSlabs: result.surchargeSlabs,
            rebate87ALimit: result.rebate87ALimit,
            rebate87AAmount: result.rebate87AAmount,
            isActive: result.isActive,
          },
        },
      });
    }

    return result;
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const existing = await this.scopedPrisma.taxSlabConfig.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Tax slab config not found.');
    // Employees who chose this regime for this financial year are taxed from these slabs; deleting them would leave
    // those declarations (and the payroll that follows) with no slabs to calculate from.
    const declarations = await this.scopedPrisma.employeeTaxDeclaration.count({
      where: {
        organizationId,
        financialYear: existing.financialYear,
        regimeChosen: existing.regime,
      },
    });
    if (declarations > 0) {
      throw new ConflictException(
        `${declarations} employee tax declaration(s) use the ${existing.regime} regime for FY ${existing.financialYear}, so these slabs can't be deleted — set them inactive instead.`,
      );
    }
    await this.scopedPrisma.taxSlabConfig.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'TAX_SLAB_DELETED',
        module: 'PAYROLL',
        organizationId,
        targetId: id,
        details: {
          financialYear: existing.financialYear,
          regime: existing.regime,
        },
      });
    }

    return { message: 'Tax slab config deleted' };
  }
}
