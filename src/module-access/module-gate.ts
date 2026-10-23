// Purpose: lets background jobs (cron reminders, auto-approvals, digests) skip companies that switched a module off, without
//   each job's constructor having to take ModuleAccessService (which would also break the tests that build those services by hand).
// Important: ModuleAccessService registers itself here at startup. Before that (and in unit tests) nothing is filtered, so a job
//   always errs on the side of running.
import type { ModuleAccessService } from './module-access.service';

let service: ModuleAccessService | null = null;
export const registerModuleGate = (s: ModuleAccessService) => {
  service = s;
};

/** The organizations in `orgs` that still have `module` switched on (e.g. 'module.attendance'). */
export async function keepModuleEnabled<T extends { id: string }>(orgs: T[], module: string): Promise<T[]> {
  if (!service || orgs.length === 0) return orgs;
  const enabled = await service.enabledAmong(orgs.map((o) => o.id), module);
  return orgs.filter((o) => enabled.has(o.id));
}

/** True unless the module is switched off for this one organization. */
export async function moduleEnabledFor(organizationId: string, module: string): Promise<boolean> {
  return service ? (await service.enabledAmong([organizationId], module)).has(organizationId) : true;
}

/** The module flags switched off for one organization (empty when none, or before the gate is up). */
export async function disabledModulesOf(organizationId: string): Promise<Set<string>> {
  return service ? service.disabledFor(organizationId) : new Set();
}

/** Which module each approval-queue request type belongs to (dashboard pending items, counts and the digest email). */
export const REQUEST_TYPE_MODULE: Record<string, string> = {
  LEAVE: 'module.leave',
  COMP_OFF: 'module.leave',
  ENCASHMENT: 'module.leave',
  REGULARIZATION: 'module.attendance',
  WFH: 'module.attendance',
  OVERTIME: 'module.attendance',
  REIMBURSEMENT: 'module.loans_reimbursements',
  LOAN: 'module.loans_reimbursements',
  RESIGNATION: 'module.offboarding',
  RESIGNATION_WITHDRAWAL: 'module.offboarding',
};

/**
 * Runs a query unless its module is switched off for this company; then it resolves to `empty` without touching the
 * database. Lets a dashboard skip a switched-off module's queries and still return the same shape (zeros, empty lists).
 */
export function gate<T>(off: Set<string>, module: string, run: () => Promise<T>, empty: T): Promise<T> {
  return off.has(module) ? Promise.resolve(empty) : run();
}

/** Throws if adding employees would pass the company's hard limit (see ModuleAccessService.assertEmployeeRoom). A no-op before the gate is up. */
export async function assertEmployeeRoom(organizationId: string, adding = 1): Promise<void> {
  if (service) await service.assertEmployeeRoom(organizationId, adding);
}
