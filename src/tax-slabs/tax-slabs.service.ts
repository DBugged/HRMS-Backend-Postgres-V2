// Purpose: CRUD for per-financial-year, per-regime TaxSlabConfig rows (slabs, standard deduction, cess,
// surcharge, 87A rebate) that PayrollService.calculatePayroll's tax engine reads.
// Responsibilities: Owns upsert-by-(financialYear, regime) and exposes getDefaults() (static slab data,
// not persisted) for the frontend to pre-fill a new config.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaxRegime, TaxSlabConfig } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertTaxSlabDto } from './dto/upsert-tax-slab.dto';
import { getDefaultTaxSlabConfig } from './default-tax-slabs';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { wrapAll } from '../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';

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

  async upsert(
    dto: UpsertTaxSlabDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.scopedPrisma.taxSlabConfig.findFirst({
      where: {
        organizationId,
        financialYear: dto.financialYear,
        regime: dto.regime,
      },
    });

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
        details: { financialYear: dto.financialYear, regime: dto.regime },
      });
    }

    return result;
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const existing = await this.scopedPrisma.taxSlabConfig.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Tax slab config not found.');
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
