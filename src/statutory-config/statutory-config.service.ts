import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StatutoryConfigVersion,
  StatutoryModule,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { RedisCacheService } from '../common/redis-cache';
import {
  dayBefore,
  localDateStr,
} from '../employee-salary-components/salary-structure-math';
import { CreateStatutoryConfigVersionDto } from './dto/create-statutory-config-version.dto';
import {
  SEED_DEFAULTS,
  validateModuleConfig,
} from './statutory-config-validation';

// getEffective() is hit once per statutory module (9) per employee inside
// PayrollService.calculatePayroll — a full payroll batch does O(9xN)
// lookups of data that changes maybe a few times a year. Cached briefly
// with invalidation on every write (create/remove), so a batch run
// collapses to effectively one DB read per distinct (module, date)
// instead of one per employee.
const EFFECTIVE_CACHE_TTL_SECONDS = 300;

@Injectable()
export class StatutoryConfigService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly cache: RedisCacheService,
  ) {}

  private effectiveCacheKeyPrefix(
    organizationId: string,
    module: StatutoryModule,
  ): string {
    return `statconfig:${organizationId}:${module}:`;
  }

  // Every new org gets all 9 modules pre-seeded (most disabled,
  // payroll_calendar/rounding always enabled) so the payroll engine's
  // period-aware resolution has a row to resolve from day one — called
  // from AuthService.register()'s existing transaction.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const today = localDateStr();
    for (const module of Object.values(StatutoryModule)) {
      const { config, isEnabled } = SEED_DEFAULTS[module];
      await tx.statutoryConfigVersion.create({
        data: {
          organizationId,
          module,
          effectiveFrom: today,
          config: config,
          isEnabled,
        },
      });
    }
  }

  getHistory(module: StatutoryModule, organizationId: string) {
    return this.scopedPrisma.statutoryConfigVersion.findMany({
      where: { organizationId, module },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  async getEffective(
    module: StatutoryModule,
    date: string,
    organizationId: string,
  ) {
    const key = `${this.effectiveCacheKeyPrefix(organizationId, module)}${date}`;
    return this.cache.getOrSet(key, EFFECTIVE_CACHE_TTL_SECONDS, async () => {
      const version = await this.scopedPrisma.statutoryConfigVersion.findFirst({
        where: {
          organizationId,
          module,
          effectiveFrom: { lte: date },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      return { date, version };
    });
  }

  async create(
    module: StatutoryModule,
    dto: CreateStatutoryConfigVersionDto,
    actorId: string,
    organizationId: string,
  ): Promise<StatutoryConfigVersion> {
    try {
      validateModuleConfig(module, dto.config);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const duplicate = await this.scopedPrisma.statutoryConfigVersion.findFirst({
      where: { organizationId, module, effectiveFrom: dto.effectiveFrom },
    });
    if (duplicate) {
      throw new ConflictException(
        `A version for ${module} already starts on ${dto.effectiveFrom} — edit or delete it instead.`,
      );
    }

    const current = await this.scopedPrisma.statutoryConfigVersion.findFirst({
      where: { organizationId, module, effectiveTo: null },
    });
    if (current) {
      await this.scopedPrisma.statutoryConfigVersion.updateMany({
        where: { id: current.id, organizationId },
        data: { effectiveTo: dayBefore(dto.effectiveFrom) },
      });
    }

    const created = await this.scopedPrisma.statutoryConfigVersion.create({
      data: {
        organizationId,
        module,
        effectiveFrom: dto.effectiveFrom,
        config: dto.config as Prisma.InputJsonValue,
        isEnabled: dto.isEnabled ?? true,
        notes: dto.notes ?? '',
        createdById: actorId,
      },
    });
    await this.cache.invalidatePrefix(
      this.effectiveCacheKeyPrefix(organizationId, module),
    );
    return created;
  }

  async remove(module: StatutoryModule, id: string, organizationId: string) {
    const row = await this.scopedPrisma.statutoryConfigVersion.findFirst({
      where: { id, organizationId, module },
    });
    if (!row)
      throw new NotFoundException('Statutory config version not found.');

    const today = localDateStr();
    if (row.effectiveFrom <= today) {
      throw new BadRequestException(
        'Only a future-dated version can be deleted — past and current versions are permanent history.',
      );
    }

    const count = await this.scopedPrisma.statutoryConfigVersion.count({
      where: { organizationId, module },
    });
    if (count <= 1) {
      throw new BadRequestException(
        'Cannot delete the only version for this module.',
      );
    }

    await this.scopedPrisma.statutoryConfigVersion.deleteMany({
      where: { id, organizationId },
    });

    // Reopen whatever version this one had closed out, so there's no
    // coverage gap.
    await this.scopedPrisma.statutoryConfigVersion.updateMany({
      where: {
        organizationId,
        module,
        effectiveTo: dayBefore(row.effectiveFrom),
      },
      data: { effectiveTo: null },
    });

    await this.cache.invalidatePrefix(
      this.effectiveCacheKeyPrefix(organizationId, module),
    );
    return { message: 'Statutory config version deleted' };
  }
}
