import { EmployeeIdService } from './employee-id.service';

type Row = Record<string, any>;

function tx(o: { brand?: Row | null; taken?: string[]; org?: Row }) {
  const updates: Row[] = [];
  const t: Row = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (String(strings[0]).includes('company_brands')) return o.brand ? [o.brand] : [];
      return [{ documentNumbering: { employeeId: { label: 'Employee ID', format: 'DP-{00000}', resetRule: 'never', counter: 7, lastPeriodKey: null } } }];
    },
    user: { findFirst: async (a: Row) => ((o.taken ?? []).includes(a.where.employeeId) ? { id: 'x' } : null) },
    companyBrand: { update: async (a: Row) => { updates.push(a); } },
    organization: { update: async () => undefined },
  };
  return { t, updates };
}

const svc = new EmployeeIdService();

describe('EmployeeIdService.generate', () => {
  it('uses the company series when there is no brand', async () => {
    expect(await svc.generate(tx({}).t as never, 'org')).toBe('DP-00008');
  });

  it('uses the brand series, and saves the counter', async () => {
    const { t, updates } = tx({ brand: { employeeIdFormat: 'SA-{00000}', employeeIdCounter: 41 } });
    expect(await svc.generate(t as never, 'org', 'b1')).toBe('SA-00042');
    expect(updates[0].data).toEqual({ employeeIdCounter: 42 });
  });

  it('skips a number somebody already holds', async () => {
    const { t, updates } = tx({ brand: { employeeIdFormat: 'SA-{00000}', employeeIdCounter: 0 }, taken: ['SA-00001', 'SA-00002'] });
    expect(await svc.generate(t as never, 'org', 'b1')).toBe('SA-00003');
    expect(updates[0].data).toEqual({ employeeIdCounter: 3 });
  });

  it('falls back to the company series for a brand with no series of its own', async () => {
    expect(await svc.generate(tx({ brand: { employeeIdFormat: null, employeeIdCounter: 0 } }).t as never, 'org', 'b1')).toBe('DP-00008');
  });
});
