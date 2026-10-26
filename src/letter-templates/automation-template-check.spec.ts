import { AutomationTemplateCheckService } from './automation-template-check.service';

type Row = Record<string, any>;

function build(o: { letters: Row[]; recent?: Row[] }) {
  const created: Row[] = [];
  const prisma: Row = {
    letterTemplate: { findMany: async () => o.letters },
    emailTemplate: { findMany: async () => [] },
    user: { findMany: async () => [{ id: 'hr1' }, { id: 'ad1' }] },
    notification: { findMany: async () => o.recent ?? [] },
  };
  const notifications = { createMany: async (rows: Row[]) => { created.push(...rows); } };
  return { svc: new AutomationTemplateCheckService(prisma as never, notifications as never), created };
}

const full = ['resignationAcceptance', 'confirmationLetter', 'probationExtensionLetter', 'relievingLetter', 'experienceCertificate'].map((key) => ({ key, isActive: true }));

describe('AutomationTemplateCheckService.notifyForOrg', () => {
  it('tells nobody when nothing is missing', async () => {
    const { svc, created } = build({ letters: full });
    expect(await svc.notifyForOrg('org')).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('tells every HR and Admin which template is missing', async () => {
    const { svc, created } = build({ letters: full.filter((l) => l.key !== 'resignationAcceptance') });
    expect(await svc.notifyForOrg('org')).toBe(2);
    expect(created[0].title).toBe('1 automatic letter/email template needs attention');
    expect(created[0].message).toContain('Resignation acceptance letter (missing)');
  });

  it('does not repeat within the week for someone already told', async () => {
    const { svc, created } = build({ letters: full.slice(1), recent: [{ userId: 'hr1' }] });
    expect(await svc.notifyForOrg('org')).toBe(1);
    expect(created.map((c) => c.userId)).toEqual(['ad1']);
  });
});
