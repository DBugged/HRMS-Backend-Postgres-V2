// Purpose: answers "is this HRMS module switched on for this company?" using the Control Center's feature flags.
// Important: a module is ON unless its flag is explicitly false (company override first, then the flag's default).
//   Fails OPEN: if the lookup errors, customers keep working. Results are cached for 30s per company; the Control
//   Center clears the cache the moment a Super Admin changes a flag, so a switch takes effect immediately on that server.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

const TTL_MS = 30_000;

@Injectable()
export class ModuleAccessService {
  private readonly logger = new Logger(ModuleAccessService.name);
  private cache = new Map<string, { at: number; disabled: Set<string> }>();

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  /** Flag keys (module.*) that are switched off for this organization. */
  async disabledFor(organizationId: string): Promise<Set<string>> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.disabled;
    try {
      const [flags, overrides] = await Promise.all([
        this.prisma.ccFeatureFlag.findMany({ where: { key: { startsWith: 'module.' }, status: 'ACTIVE' } }),
        this.prisma.ccFlagOverride.findMany({ where: { organizationId, flagKey: { startsWith: 'module.' } } }),
      ]);
      const over = new Map(overrides.map((o) => [o.flagKey, o.value]));
      const disabled = new Set(flags.filter((f) => (over.has(f.key) ? over.get(f.key) : f.defaultValue) === false).map((f) => f.key));
      this.cache.set(organizationId, { at: Date.now(), disabled });
      return disabled;
    } catch (e) {
      this.logger.warn(`Module lookup failed, allowing access: ${(e as Error).message}`);
      return new Set();
    }
  }

  /** Called by the Control Center after any flag or override change. */
  clear() {
    this.cache.clear();
  }
}
