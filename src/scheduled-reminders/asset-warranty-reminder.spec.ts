import { AssetWarrantyReminderService, warrantyDaysLeft, warrantyMark } from './asset-warranty-reminder.service';

describe('warranty marks', () => {
  it('picks the tightest mark and ignores far-off or ended warranties', () => {
    expect(warrantyMark(30)).toBe(30);
    expect(warrantyMark(8)).toBe(30);
    expect(warrantyMark(7)).toBe(7);
    expect(warrantyMark(0)).toBe(7);
    expect(warrantyMark(31)).toBeNull();
    expect(warrantyMark(-1)).toBeNull();
    expect(warrantyDaysLeft('2026-11-02', '2026-11-09')).toBe(7);
  });
});

function build(opts: { assets: any[]; already: boolean }) {
  const created: any[] = [];
  const prisma: any = {
    asset: { findMany: jest.fn().mockResolvedValue(opts.assets) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'h1' }, { id: 'a1' }]) },
    notification: { findFirst: jest.fn().mockResolvedValue(opts.already ? { id: 'n' } : null) },
  };
  const notifications: any = { createMany: jest.fn(async (x) => created.push(...x)) };
  return { svc: new AssetWarrantyReminderService(prisma, notifications), created };
}

describe('AssetWarrantyReminderService', () => {
  const asset = (end: string) => ({ id: 'x', assetCode: 'AST-1', assetName: 'Laptop', warrantyEndDate: new Date(`${end}T00:00:00.000Z`) });
  it('tells every HR/Admin once per asset and mark', async () => {
    const { svc, created } = build({ assets: [asset('2026-11-20')], already: false });
    expect(await svc.remindForOrg('o1', '2026-11-02')).toBe(1);
    expect(created).toHaveLength(2);
    expect(created[0].title).toBe('Warranty ending soon: AST-1');
  });
  it('uses the this-week wording inside 7 days and never repeats a mark', async () => {
    const week = build({ assets: [asset('2026-11-05')], already: false });
    await week.svc.remindForOrg('o1', '2026-11-02');
    expect(week.created[0].title).toBe('Warranty ends this week: AST-1');
    const again = build({ assets: [asset('2026-11-05')], already: true });
    expect(await again.svc.remindForOrg('o1', '2026-11-02')).toBe(0);
  });
  it('does nothing without assets in the window', async () => {
    expect(await build({ assets: [], already: false }).svc.remindForOrg('o1', '2026-11-02')).toBe(0);
  });
});
