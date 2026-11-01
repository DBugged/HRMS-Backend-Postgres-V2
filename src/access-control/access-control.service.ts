// Purpose: Lists, from the server's own route decorators, who may call each endpoint - the "what can each role do" view.
// Responsibilities: walks every registered controller and, for each route, reads @Roles / @SelfOrRoles / @Public (handler first,
//   then the controller) exactly as the guards do, so the answer cannot drift from what is enforced. Read-only; computed once.
// Important: a route with none of these is open to any signed-in user and relies on the service's own scoping (own data,
//   own department ...) - reported as ANY_SIGNED_IN, not as "everyone can do anything". Platform (Control Center) routes use
//   a separate auth and are left out, as are the internal service routes.
import { Inject, Injectable } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { SELF_OR_ROLES_KEY, type SelfOrRolesMeta } from '../common/decorators/self-or-roles.decorator';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

export type AccessKind = 'ROLES' | 'SELF_OR_ROLES' | 'ANY_SIGNED_IN' | 'PUBLIC';

export interface RouteAccess {
  module: string;
  method: string;
  path: string;
  action: string;
  access: AccessKind;
  roles: string[];
  selfParam?: string;
  // Flagged by its name and method as touching money, settings, accounts or personal data, or as destructive.
  sensitive: boolean;
}

const SENSITIVE_PATH = /(salary|payroll|settlement|statutory|tax|opening-balance|organizations|privacy|password|role|bank|users|audit|access-control)/;
const SENSITIVE_ACTION = /\/(lock|unlock|pay|finalize|erase|purge|reset|impersonate)(\/|$)/;
const SENSITIVE_READ = /(export|download|report|pdf|bank)/;
export function isSensitive(method: string, path: string): boolean {
  if (method === 'DELETE') return true;
  if (SENSITIVE_ACTION.test(path)) return true;
  if (method !== 'GET') return SENSITIVE_PATH.test(path);
  return SENSITIVE_READ.test(path) && /(payroll|salary|tds|settlement|employee|bank)/.test(path);
}

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

const words = (name: string) => {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
const join = (...parts: string[]) => '/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

@Injectable()
export class AccessControlService {
  private cache: RouteAccess[] | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  routes(): RouteAccess[] {
    if (this.cache) return this.cache;
    const out: RouteAccess[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const base = String(Reflect.getMetadata('path', metatype) ?? '');
      if (/^(control-center|platform|cc|api|internal)(\/|$)/.test(base)) continue;
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const methodCode = Reflect.getMetadata('method', handler as object) as number | undefined;
        if (methodCode === undefined || METHODS[methodCode] === undefined) continue;
        const sub = String(Reflect.getMetadata('path', handler as object) ?? '');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        const targets: (Function | typeof metatype)[] = [handler as Function, metatype];
        const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets);
        const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, targets);
        const selfOrRoles = this.reflector.getAllAndOverride<SelfOrRolesMeta | undefined>(SELF_OR_ROLES_KEY, targets);
        const route: RouteAccess = {
          module: base.split('/')[0] || 'root',
          method: METHODS[methodCode],
          path: join(base, sub),
          action: words(name),
          access: isPublic ? 'PUBLIC' : roles ? 'ROLES' : selfOrRoles ? 'SELF_OR_ROLES' : 'ANY_SIGNED_IN',
          roles: isPublic ? [] : (roles ?? selfOrRoles?.roles ?? []),
          ...(selfOrRoles && !roles ? { selfParam: selfOrRoles.paramKey } : {}),
          sensitive: false,
        };
        route.sensitive = isSensitive(route.method, route.path);
        out.push(route);
      }
    }
    this.cache = out.sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    return this.cache;
  }

  // Who holds which role: counts for every role, the people who hold Admin or HR (the powerful accounts), and the latest role
  // changes (who changed whose role, from what to what, when) from the audit log.
  async people(organizationId: string) {
    const [grouped, privileged, audits] = await Promise.all([
      this.scopedPrisma.user.groupBy({ by: ['role'], where: { organizationId, isActive: true }, _count: { _all: true } }),
      this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true, role: { in: ['ADMIN', 'HR'] } },
        select: { id: true, name: true, employeeId: true, role: true, email: true },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      }),
      this.scopedPrisma.auditLog.findMany({
        where: { organizationId, action: 'EMPLOYEE_UPDATED' },
        orderBy: { createdAt: 'desc' },
        take: 400,
        select: { actorId: true, targetId: true, details: true, createdAt: true },
      }),
    ]);
    const counts = { ADMIN: 0, HR: 0, MANAGER: 0, EMPLOYEE: 0 } as Record<string, number>;
    for (const g of grouped) counts[g.role] = g._count._all;
    const changes = audits
      .map((a) => {
        const d = (a.details ?? {}) as { changes?: { role?: { before?: string; after?: string } } };
        return d.changes?.role ? { actorId: a.actorId, targetId: a.targetId, from: d.changes.role.before ?? '', to: d.changes.role.after ?? '', at: a.createdAt } : null;
      })
      .filter((c): c is NonNullable<typeof c> => !!c)
      .slice(0, 15);
    const ids = [...new Set(changes.flatMap((c) => [c.actorId, c.targetId ?? '']).filter(Boolean))];
    const users = await this.scopedPrisma.user.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return {
      counts,
      privileged,
      roleChanges: changes.map((c) => ({ by: nameOf.get(c.actorId) ?? 'Unknown', employee: nameOf.get(c.targetId ?? '') ?? 'Unknown', from: c.from, to: c.to, at: c.at })),
    };
  }
}
