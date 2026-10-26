import { ResignationReminderService } from './resignation-reminder.service';

type Row = Record<string, any>;
const NOW = new Date('2026-12-10T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

function build(o: { ageDays: number; employeeRole?: string; people?: Row[] }) {
  const sent: Row[] = [];
  const prisma: Row = {
    resignation: {
      findMany: async () => [
        { id: 'r1', status: 'PENDING', createdAt: daysAgo(o.ageDays), requestedLwd: '2027-01-10', employee: { id: 'e1', name: 'Asha', role: o.employeeRole ?? 'EMPLOYEE', reportingManagerId: 'm1', additionalReportingManagerIds: [], isActive: true } },
      ],
    },
    user: {
      findMany: async () =>
        o.people ?? [
          { id: 'm1', name: 'Manager', email: 'm@x.com', role: 'MANAGER', notificationPreferences: null },
          { id: 'hr1', name: 'HR', email: 'h@x.com', role: 'HR', notificationPreferences: null },
          { id: 'ad1', name: 'Admin', email: 'a@x.com', role: 'ADMIN', notificationPreferences: null },
        ],
    },
  };
  const notifier = { send: async (i: Row) => { sent.push(i); return true; } };
  return { svc: new ResignationReminderService(prisma as never, notifier as never), sent };
}

describe('ResignationReminderService.remindForOrg', () => {
  it('reminds the manager and HR (not the Admin, who gets the escalation) at day 2', async () => {
    const { svc, sent } = build({ ageDays: 2 });
    expect(await svc.remindForOrg('org', NOW)).toBe(2);
    expect(sent.map((s) => s.user.id).sort()).toEqual(['hr1', 'm1']);
    expect(sent[0].occasionKey).toBe('RESIGNATION_PENDING_REMINDER');
    expect(sent[0].title).toContain('Resignation waiting 2 days: Asha');
  });

  it('keeps reminding every 2 days, and not in between', async () => {
    expect(await build({ ageDays: 4 }).svc.remindForOrg('org', NOW)).toBe(2);
    expect(await build({ ageDays: 3 }).svc.remindForOrg('org', NOW)).toBe(0);
    expect(await build({ ageDays: 1 }).svc.remindForOrg('org', NOW)).toBe(0);
  });

  it('an HR employee\'s resignation goes to the Admin, who decides it', async () => {
    const { svc, sent } = build({ ageDays: 2, employeeRole: 'HR', people: [{ id: 'ad1', name: 'Admin', email: 'a@x.com', role: 'ADMIN', notificationPreferences: null }] });
    await svc.remindForOrg('org', NOW);
    expect(sent.map((s) => s.user.id)).toEqual(['ad1']);
  });

  it('with no HR user the Admin is reminded too', async () => {
    const { svc, sent } = build({ ageDays: 2, people: [{ id: 'ad1', name: 'Admin', email: 'a@x.com', role: 'ADMIN', notificationPreferences: null }] });
    await svc.remindForOrg('org', NOW);
    expect(sent.map((s) => s.user.id)).toEqual(['ad1']);
  });
});
