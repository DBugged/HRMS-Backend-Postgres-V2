// Purpose: answers "is this HRMS module switched on for this company?" using the Control Center's feature flags.
// Important: a module is ON unless its flag is explicitly false (company override first, then the flag's default).
//   Fails OPEN: if the lookup errors, customers keep working. Results are cached for 30s per company; the Control
//   Center clears the cache the moment a Super Admin changes a flag, so a switch takes effect immediately on that server.
import { ForbiddenException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { employeeLimitMessage, employeeRoom } from './employee-room';
import { registerModuleGate } from './module-gate';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

const TTL_MS = 30_000;

@Injectable()
export class ModuleAccessService implements OnModuleInit {
  private readonly logger = new Logger(ModuleAccessService.name);
  private cache = new Map<string, { at: number; disabled: Set<string> }>();
  private featureCache = new Map<string, { at: number; on: boolean }>();

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  onModuleInit() {
    registerModuleGate(this);
  }

  /**
   * Of these organizations, the ones that still have the module on. One query pair for the whole list (scheduled jobs loop over
   * every company, so asking per company would be thousands of lookups). Fails open like disabledFor.
   */
  async enabledAmong(organizationIds: string[], module: string): Promise<Set<string>> {
    try {
      const [flag, overrides] = await Promise.all([
        this.prisma.ccFeatureFlag.findUnique({ where: { key: module } }),
        this.prisma.ccFlagOverride.findMany({ where: { flagKey: module, organizationId: { in: organizationIds } } }),
      ]);
      if (!flag || flag.status !== 'ACTIVE') return new Set(organizationIds);
      const over = new Map(overrides.map((o) => [o.organizationId, o.value]));
      return new Set(organizationIds.filter((id) => (over.has(id) ? over.get(id) : flag.defaultValue) !== false));
    } catch (e) {
      this.logger.warn(`Module lookup failed, allowing all: ${(e as Error).message}`);
      return new Set(organizationIds);
    }
  }

  /**
   * Whether an opt-in feature (e.g. 'feature.sister_companies') is switched ON for this organization: the company's own override first,
   * else the flag's default. Unlike modules, a feature is OFF unless explicitly on; a missing or inactive flag, or any lookup error, is off.
   */
  async featureEnabledFor(organizationId: string, key: string): Promise<boolean> {
    const k = `${organizationId}:${key}`;
    const hit = this.featureCache.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
    try {
      const [flag, override] = await Promise.all([
        this.prisma.ccFeatureFlag.findUnique({ where: { key } }),
        this.prisma.ccFlagOverride.findFirst({ where: { organizationId, flagKey: key } }),
      ]);
      const on = !!flag && flag.status === 'ACTIVE' && (override ? override.value === true : flag.defaultValue === true);
      this.featureCache.set(k, { at: Date.now(), on });
      return on;
    } catch (e) {
      this.logger.warn(`Feature lookup failed, treating ${key} as off: ${(e as Error).message}`);
      return false;
    }
  }

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

  /**
   * Refuses (403 EMPLOYEE_LIMIT_REACHED) when adding `adding` more active employees would pass the hard limit the Super
   * Admin set on this company's subscription. No limit set, no subscription, or any lookup error: allowed (fails open).
   */
  async assertEmployeeRoom(organizationId: string, adding = 1): Promise<void> {
    let verdict;
    try {
      const sub = await this.prisma.ccSubscription.findFirst({
        where: { organizationId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
        orderBy: { createdAt: 'desc' },
        select: { maxEmployees: true },
      });
      if (sub?.maxEmployees == null) return;
      const used = await this.prisma.user.count({ where: { organizationId, isActive: true } });
      verdict = employeeRoom(sub.maxEmployees, used, adding);
    } catch (e) {
      this.logger.warn(`Employee limit check failed, allowing: ${(e as Error).message}`);
      return;
    }
    if (!verdict.allowed) throw new ForbiddenException({ statusCode: 403, code: 'EMPLOYEE_LIMIT_REACHED', message: employeeLimitMessage(verdict) });
  }

  /** Called by the Control Center after any flag or override change. */
  clear() {
    this.cache.clear();
    this.featureCache.clear();
  }
}
