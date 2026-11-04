// Regression: the tenant-scoped Prisma client refuses update/delete by id on organisation-owned models ("use
// updateMany/deleteMany with { id, organizationId }"). Unit mocks never enforced that, so ShiftRule / OvertimeRuleSet /
// Department-budget writes shipped broken. These fakes throw exactly as the guard does.
import { OvertimeRuleSetsService } from './overtime-rule-sets.service';
import { ShiftRulesService } from '../work-schedules/shift-rules.service';
import { OvertimeReportService } from './overtime-report.service';

const refuse = (model: string, op: string) => () => {
  throw new Error(`${model}.${op}: not allowed on a tenant-scoped model`);
};
const audit = { log: jest.fn().mockResolvedValue(undefined) };

describe('tenant-safe writes', () => {
  it('rule sets: update and delete use updateMany/deleteMany scoped by organisation', async () => {
    const row = {
      id: 'r1',
      name: 'A',
      employeeIds: ['e1'],
      departmentIds: [],
      employeeTypes: [],
      designations: [],
      policy: {},
    };
    const calls: string[] = [];
    const db = {
      overtimeRuleSet: {
        findFirst: jest.fn().mockResolvedValue(row),
        findFirstOrThrow: jest.fn().mockResolvedValue(row),
        update: refuse('OvertimeRuleSet', 'update'),
        delete: refuse('OvertimeRuleSet', 'delete'),
        updateMany: jest.fn(async (a: { where: unknown }) => {
          calls.push(JSON.stringify(a.where));
          return { count: 1 };
        }),
        deleteMany: jest.fn(async (a: { where: unknown }) => {
          calls.push(JSON.stringify(a.where));
          return { count: 1 };
        }),
      },
      user: { count: jest.fn().mockResolvedValue(1) },
      department: { count: jest.fn().mockResolvedValue(0) },
    };
    const svc = new OvertimeRuleSetsService(db as never, audit as never);
    await expect(
      svc.update('r1', { isActive: false }, 'org', { id: 'u' }),
    ).resolves.toBeDefined();
    await expect(svc.remove('r1', 'org', { id: 'u' })).resolves.toEqual({
      deleted: true,
    });
    expect(calls).toEqual([
      '{"id":"r1","organizationId":"org"}',
      '{"id":"r1","organizationId":"org"}',
    ]);
  });

  it('shift rules: update and delete use updateMany/deleteMany scoped by organisation', async () => {
    const row = {
      id: 's1',
      name: 'W',
      gender: 'FEMALE',
      startTime: '09:00',
      endTime: '18:00',
      breakMinutes: null,
      departmentIds: [],
      employeeIds: [],
      isActive: true,
    };
    const db = {
      shiftRule: {
        findFirst: jest.fn().mockResolvedValueOnce(row).mockResolvedValue(null),
        findFirstOrThrow: jest.fn().mockResolvedValue(row),
        update: refuse('ShiftRule', 'update'),
        delete: refuse('ShiftRule', 'delete'),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      department: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'd', name: 'D', breakMinutes: 60, minHoursForPresent: 8 },
          ]),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new ShiftRulesService(db as never, audit as never, {} as never);
    await expect(
      svc.update('s1', { isActive: false }, 'org', { id: 'u' }),
    ).resolves.toBeDefined();
    db.shiftRule.findFirst.mockResolvedValueOnce(row);
    await expect(svc.remove('s1', 'org', { id: 'u' })).resolves.toEqual({
      deleted: true,
    });
    expect(db.shiftRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's1', organizationId: 'org' } }),
    );
    expect(db.shiftRule.deleteMany).toHaveBeenCalledWith({
      where: { id: 's1', organizationId: 'org' },
    });
  });

  it('department budget: written with updateMany scoped by organisation', async () => {
    const db = {
      department: {
        findFirst: jest.fn().mockResolvedValue({ id: 'd1' }),
        update: refuse('Department', 'update'),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const svc = new OvertimeReportService(db as never, audit as never);
    await expect(svc.setBudget('d1', 20, 'org', 'u')).resolves.toEqual({
      departmentId: 'd1',
      budgetHours: 20,
    });
    expect(db.department.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', organizationId: 'org' },
      data: { overtimeBudgetHours: 20 },
    });
  });
});
