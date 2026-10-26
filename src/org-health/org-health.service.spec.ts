import { OrgHealthService } from './org-health.service';

type Row = Record<string, any>;

const person = (id: string, o: Row = {}) => ({
  id, name: id.toUpperCase(), employeeId: `DP-${id}`, isActive: true, employmentStatus: 'CONFIRMED', exitDate: null,
  reportingManagerId: null, additionalReportingManagerIds: [], ...o,
});

function build(o: { people: Row[]; departments?: Row[]; settings?: Row }) {
  const created: Row[] = [];
  const prisma: Row = {
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata', attendancePayrollPrefs: null, epfoEstablishmentCode: 'MHBAN0012345', esicEmployerCode: null, ptRegistrationNumber: null }) },
    user: { findMany: async (a: Row) => (a.where?.role ? [{ id: 'hr1' }, { id: 'ad1' }] : o.people), count: async () => o.people.length },
    department: { count: async () => 2, findMany: async () => o.departments ?? [] },
    workLocation: { count: async () => 1 }, workSchedule: { count: async () => 1 }, orgListItem: { count: async () => 1 },
    leaveType: { count: async () => 1 }, holiday: { count: async () => 1 }, salaryComponent: { count: async () => 1 },
    documentRequirement: { count: async () => 1 },
    notification: { findMany: async () => [] },
  };
  const settings = { processingDay: 0, paymentDay: 0, pfEnabled: false, esiEnabled: false, ptEnabled: false, taxRegimeEmployeeChange: true, taxRegimeCutoffMonth: null, ...(o.settings ?? {}) };
  const payroll = { getWithResolvedDates: async () => ({ settings, resolvedForCurrentMonth: { processingDate: '2026-11-26', paymentDate: '2026-11-30' } }) };
  const notifications = { createMany: async (rows: Row[]) => { created.push(...rows); } };
  return { svc: new OrgHealthService(prisma as never, payroll as never, notifications as never), created };
}

describe('OrgHealthService.get', () => {
  it('finds a leaver who still has working reports, and ignores reports who have left too', async () => {
    const { svc } = build({
      people: [
        person('boss', { isActive: false }),
        person('a', { reportingManagerId: 'boss' }),
        person('b', { additionalReportingManagerIds: ['boss'] }),
        person('gone', { isActive: false, reportingManagerId: 'boss' }),
        person('fine', { reportingManagerId: 'a' }),
      ],
    });
    const h = await svc.get('org');
    expect(h.leaverTeams).toHaveLength(1);
    expect(h.leaverTeams[0]).toMatchObject({ managerId: 'boss', name: 'BOSS' });
    expect(h.leaverTeams[0].reports.map((r: Row) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('finds an active department still headed by a leaver', async () => {
    const { svc } = build({
      people: [person('head', { employmentStatus: 'RELEASED' }), person('ok')],
      departments: [{ id: 'd1', name: 'Sales', departmentHeadId: 'head' }, { id: 'd2', name: 'Ops', departmentHeadId: 'ok' }],
    });
    expect((await svc.get('org')).leaverDepartments).toEqual([{ departmentId: 'd1', name: 'Sales', headId: 'head', headName: 'HEAD' }]);
  });

  it('reports the settings clash and the setup progress', async () => {
    const { svc } = build({ people: [person('a'), person('b')], settings: { pfEnabled: true } });
    expect((await svc.get('org')).warnings.map((w: Row) => w.key)).toEqual([]);
    const withEsi = build({ people: [person('a'), person('b')], settings: { esiEnabled: true } });
    const h = await withEsi.svc.get('org');
    expect(h.warnings.map((w: Row) => w.key)).toEqual(['esi-no-code']);
    expect(h.setup.percent).toBe(100);
  });
});

describe('OrgHealthService.notifyForOrg', () => {
  it('tells nobody when all is well', async () => {
    const { svc, created } = build({ people: [person('a'), person('b')] });
    expect(await svc.notifyForOrg('org')).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('tells every HR and Admin what to fix', async () => {
    const { svc, created } = build({ people: [person('boss', { isActive: false }), person('a', { reportingManagerId: 'boss' })] });
    expect(await svc.notifyForOrg('org')).toBe(2);
    expect(created[0].title).toBe('1 organization setup issue to fix');
    expect(created[0].message).toContain('BOSS has left but 1 person still reports to them');
  });
});
