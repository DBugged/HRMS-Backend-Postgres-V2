import { ConflictException, NotFoundException } from '@nestjs/common';
import { CompanyBrandsService } from './company-brands.service';

type Row = Record<string, any>;

function build(o: { brands?: Row[]; users?: number; orgFormat?: string } = {}) {
  const brands: Row[] = o.brands ?? [];
  const written: Row[] = [];
  const tx: Row = {
    companyBrand: {
      updateMany: async (a: Row) => { written.push({ op: 'updateMany', ...a }); },
      create: async (a: Row) => { written.push({ op: 'create', ...a }); return { id: 'new', ...a.data }; },
      findFirstOrThrow: async () => brands[0],
    },
  };
  const prisma: Row = {
    companyBrand: {
      findMany: async () => brands,
      findFirst: async (a: Row) => {
        const w = a.where;
        if (w.id && typeof w.id === 'string') return brands.find((b) => b.id === w.id) ?? null;
        if (w.name?.equals) return brands.find((b) => b.name.toLowerCase() === w.name.equals.toLowerCase() && b.id !== w.id?.not) ?? null;
        return null;
      },
      deleteMany: async () => { written.push({ op: 'delete' }); },
    },
    organization: { findFirst: async () => ({ documentNumbering: { employeeId: { format: o.orgFormat ?? 'DP-{00000}' } } }), findMany: async () => [] },
    $queryRaw: async () => [],
    user: { count: async () => o.users ?? 0 },
    $transaction: async (fn: (t: Row) => unknown) => fn(tx),
  };
  const svc = new CompanyBrandsService(prisma as never, { log: async () => undefined } as never);
  return { svc, written };
}

const actor = { id: 'a1' } as never;

describe('CompanyBrandsService.create', () => {
  it('starts the series at the chosen number', async () => {
    const { svc, written } = build();
    await svc.create({ name: 'Sister A', employeeIdFormat: 'SA-{00000}', employeeIdStart: 100 }, actor, 'org');
    expect(written.find((w) => w.op === 'create')!.data).toMatchObject({ name: 'Sister A', employeeIdFormat: 'SA-{00000}', employeeIdCounter: 99 });
  });

  it('refuses a duplicate name, ignoring case', async () => {
    const { svc } = build({ brands: [{ id: 'b1', name: 'Sister A', employeeIdFormat: null }] });
    await expect(svc.create({ name: 'sister a' }, actor, 'org')).rejects.toThrow(ConflictException);
  });

  it('refuses an ID prefix already used by another brand or by the company', async () => {
    const other = build({ brands: [{ id: 'b1', name: 'Sister A', employeeIdFormat: 'SA-{00000}' }] });
    await expect(other.svc.create({ name: 'B', employeeIdFormat: 'SA-{0000}' }, actor, 'org')).rejects.toThrow(/already used by Sister A/);
    await expect(build().svc.create({ name: 'B', employeeIdFormat: 'DP-{00000}' }, actor, 'org')).rejects.toThrow(/company's own employee IDs/);
  });

  it('clears the previous default when a new default is set', async () => {
    const { svc, written } = build();
    await svc.create({ name: 'Sister A', isDefault: true }, actor, 'org');
    expect(written[0]).toMatchObject({ op: 'updateMany', data: { isDefault: false } });
  });
});

describe('CompanyBrandsService.remove', () => {
  it('refuses to delete a company that employees are tagged with', async () => {
    const { svc } = build({ brands: [{ id: 'b1', name: 'A' }], users: 3 });
    await expect(svc.remove('b1', actor, 'org')).rejects.toThrow(/3 employees are tagged/);
  });

  it('deletes an unused company, and 404s for an unknown one', async () => {
    const { svc, written } = build({ brands: [{ id: 'b1', name: 'A' }] });
    await svc.remove('b1', actor, 'org');
    expect(written.some((w) => w.op === 'delete')).toBe(true);
    await expect(svc.remove('nope', actor, 'org')).rejects.toThrow(NotFoundException);
  });
});

describe('CompanyBrandsService.update', () => {
  it('refuses to make an inactive brand the default', async () => {
    const { svc } = build({ brands: [{ id: 'b1', name: 'A', isActive: false, employeeIdFormat: null }] });
    await expect(svc.update('b1', { isDefault: true }, actor, 'org')).rejects.toThrow(/inactive/);
  });
});
