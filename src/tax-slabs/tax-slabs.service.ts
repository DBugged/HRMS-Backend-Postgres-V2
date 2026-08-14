import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaxRegime } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertTaxSlabDto } from './dto/upsert-tax-slab.dto';
import { getDefaultTaxSlabConfig } from './default-tax-slabs';

@Injectable()
export class TaxSlabsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  getDefaults(regime: TaxRegime) {
    return getDefaultTaxSlabConfig(regime);
  }

  findAll(financialYear: string | undefined, organizationId: string) {
    return this.scopedPrisma.taxSlabConfig.findMany({
      where: { organizationId, ...(financialYear && { financialYear }) },
      orderBy: [{ financialYear: 'desc' }, { regime: 'asc' }],
    });
  }

  async upsert(dto: UpsertTaxSlabDto, organizationId: string) {
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

    if (existing) {
      await this.scopedPrisma.taxSlabConfig.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      return this.scopedPrisma.taxSlabConfig.findFirstOrThrow({
        where: { id: existing.id, organizationId },
      });
    }

    return this.scopedPrisma.taxSlabConfig.create({
      data: {
        organizationId,
        financialYear: dto.financialYear,
        regime: dto.regime,
        ...data,
      },
    });
  }

  async remove(id: string, organizationId: string) {
    const existing = await this.scopedPrisma.taxSlabConfig.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Tax slab config not found.');
    await this.scopedPrisma.taxSlabConfig.deleteMany({
      where: { id, organizationId },
    });
    return { message: 'Tax slab config deleted' };
  }
}
