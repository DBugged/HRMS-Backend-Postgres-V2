import { BadRequestException } from '@nestjs/common';
import { EmployeesService } from './employees.service';

type Row = Record<string, any>;

function build(o: { users: Row[]; brand?: Row | null }) {
  const updates: Row[] = [];
  const audits: Row[] = [];
  const svc = Object.create(EmployeesService.prototype) as any;
  svc.scopedPrisma = {
    companyBrand: { findFirst: async () => (o.brand === undefined ? { isActive: true } : o.brand) },
    user: {
      findMany: async () => o.users,
      updateMany: async (a: Row) => { updates.push(a); },
    },
  };
  svc.auditLogService = { log: async (e: Row) => { audits.push(e); } };
  return { svc: svc as EmployeesService, updates, audits };
}

const admin = { id: 'a1', role: 'ADMIN' } as never;
const hr = { id: 'h1', role: 'HR' } as never;
const users = [{ id: 'e1', role: 'EMPLOYEE' }, { id: 'e2', role: 'EMPLOYEE' }, { id: 'ad', role: 'ADMIN' }];

describe('EmployeesService.bulkSetCompany', () => {
  it('sets the company on everyone for an Admin, and audits it', async () => {
    const { svc, updates, audits } = build({ users });
    expect(await svc.bulkSetCompany(['e1', 'e2', 'ad'], 'b1', admin, 'org')).toEqual({ updated: 3, skipped: 0 });
    expect(updates[0].data).toEqual({ brandId: 'b1' });
    expect(audits[0]).toMatchObject({ action: 'EMPLOYEES_COMPANY_SET' });
  });

  it('skips an Admin account when HR does it', async () => {
    const { svc, updates } = build({ users });
    expect(await svc.bulkSetCompany(['e1', 'e2', 'ad'], 'b1', hr, 'org')).toEqual({ updated: 2, skipped: 1 });
    expect(updates[0].where.id.in).toEqual(['e1', 'e2']);
  });

  it('clears the company with null', async () => {
    const { svc, updates } = build({ users });
    await svc.bulkSetCompany(['e1'], null, admin, 'org');
    expect(updates[0].data).toEqual({ brandId: null });
  });

  it('refuses an unknown or inactive company before changing anything', async () => {
    const missing = build({ users, brand: null });
    await expect(missing.svc.bulkSetCompany(['e1'], 'nope', admin, 'org')).rejects.toThrow(BadRequestException);
    expect(missing.updates).toHaveLength(0);
    const off = build({ users, brand: { isActive: false } });
    await expect(off.svc.bulkSetCompany(['e1'], 'b1', admin, 'org')).rejects.toThrow(/inactive/);
  });
});
