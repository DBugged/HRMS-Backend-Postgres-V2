import { DocumentExpiryReminderService, expiryWhen } from './document-expiry-reminder.service';

type Row = Record<string, any>;

function build(docs: Row[]) {
  const sent: Row[] = [];
  const prisma: Row = { employeeDocument: { findMany: async () => docs } };
  const notifier = {
    activeUsers: async () => [
      { id: 'e1', name: 'Asha', email: 'a@x.com', role: 'EMPLOYEE', notificationPreferences: null },
      { id: 'hr1', name: 'HR', email: 'h@x.com', role: 'HR', notificationPreferences: null },
    ],
    send: async (i: Row) => { sent.push(i); return true; },
  };
  return { svc: new DocumentExpiryReminderService(prisma as never, notifier as never), sent };
}

const doc = (expiryDate: string, employeeId = 'e1') => ({ id: 'd1', employeeId, docType: 'Passport', expiryDate });

describe('DocumentExpiryReminderService.remindForOrg', () => {
  it('reminds the owner (email) and HR (in-app only) 15 days before expiry', async () => {
    const { svc, sent } = build([doc('2026-12-25')]);
    expect(await svc.remindForOrg('org', '2026-12-10')).toBe(2);
    const owner = sent.find((s) => s.user.id === 'e1')!;
    const hr = sent.find((s) => s.user.id === 'hr1')!;
    expect(owner.title).toBe('Your Passport expires in 15 days');
    expect(owner.inAppOnly).toBeUndefined();
    expect(hr.inAppOnly).toBe(true);
    expect(hr.title).toContain('Passport of Asha');
  });

  it('reminds at 30, 7 days and on the day, and not in between or after', async () => {
    for (const [expiry, n] of [['2027-01-09', 2], ['2026-12-17', 2], ['2026-12-10', 2], ['2026-12-20', 0], ['2026-12-09', 0]] as const) {
      expect(await build([doc(expiry)]).svc.remindForOrg('org', '2026-12-10')).toBe(n);
    }
  });

  it('does not remind about someone who has left (not an active user)', async () => {
    expect(await build([doc('2026-12-25', 'gone')]).svc.remindForOrg('org', '2026-12-10')).toBe(0);
  });

  it('words the day as today or in N days', () => {
    expect(expiryWhen(0)).toBe('today');
    expect(expiryWhen(1)).toBe('in 1 day');
    expect(expiryWhen(30)).toBe('in 30 days');
  });
});
