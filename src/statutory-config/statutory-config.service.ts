// Purpose: Versioned, effective-dated statutory config (PF/ESI/PT/LWF/NPS/Gratuity/Bonus/Income
// Tax/Employer Insurance) per module, with the read path PayrollService relies on to resolve "what applied
// on this date."
// Responsibilities: Owns getEffective() (cached point-in-time resolution) and create()/remove() version
// management, closing out the currently-open version's effectiveTo when a new one starts and reopening it
// if the newer one is deleted; seedDefaults() pre-populates all 9 modules at registration.
// Important: getEffective() is cached (5 min TTL, invalidated on every write) because it's hit once per
// module per employee inside a full payroll batch — O(9xN) lookups of data that rarely changes. remove()
// only allows deleting a future-dated version — past/current versions are permanent history — and refuses
// to delete the last remaining version for a module.
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

    // Versioning is append-only: a new version must start strictly after
    // every existing version's effectiveFrom for this module. Without this
    // check, a backdated create() would still blindly close out whichever
    // row currently has effectiveTo: null — even when that row's
    // effectiveFrom is AFTER the new (earlier) date — producing an inverted
    // range (effectiveFrom > effectiveTo) that can never resolve in
    // getEffective() and silently orphans that version's data.
    const latest = await this.scopedPrisma.statutoryConfigVersion.findFirst({
      where: { organizationId, module },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (latest && dto.effectiveFrom < latest.effectiveFrom) {
      throw new BadRequestException(
        `New version must start after the most recent version's effective date (${latest.effectiveFrom}). Versions must be created in chronological order — backdating before the latest version is not supported.`,
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
