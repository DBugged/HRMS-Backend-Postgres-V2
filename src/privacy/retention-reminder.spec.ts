import { RetentionReminderService } from './retention-reminder.service';

function build(opts: { period: number | null; due: number; recent: boolean }) {
  const created: any[] = [];
  const prisma: any = {
    user: {
      count: jest.fn().mockResolvedValue(opts.due),
      findMany: jest.fn().mockResolvedValue([{ id: 'a1' }]),
    },
    notification: {
      findFirst: jest.fn().mockResolvedValue(opts.recent ? { id: 'n' } : null),
    },
  };
  const notifications: any = { createMany: jest.fn(async (x) => created.push(...x)) };
  const privacy: any = {
    ensureSettings: jest.fn().mockResolvedValue({
      retentionRules: opts.period === null ? [] : [{ dataType: 'employee_profile', periodMonths: opts.period }],
    }),
  };
  return { svc: new RetentionReminderService(prisma, notifications, privacy), created, prisma };
}

describe('RetentionReminderService', () => {
  it('tells the Admins when former employees are past retention', async () => {
    const { svc, created } = build({ period: 24, due: 3, recent: false });
    expect(await svc.remindForOrg('o1')).toBe(3);
    expect(created).toHaveLength(1);
    expect(created[0].message).toContain('3 former employees are past the 24-month');
  });
  it('does nothing without a retention period or without anyone due', async () => {
    expect(await build({ period: null, due: 5, recent: false }).svc.remindForOrg('o1')).toBe(0);
    const none = build({ period: 24, due: 0, recent: false });
    expect(await none.svc.remindForOrg('o1')).toBe(0);
    expect(none.created).toHaveLength(0);
  });
  it('reminds at most once a month', async () => {
    const { svc, created } = build({ period: 24, due: 2, recent: true });
    await svc.remindForOrg('o1');
    expect(created).toHaveLength(0);
  });
});
