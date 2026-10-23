import { summariseModules, type VersionRow } from './statutory-summary';

const v = (module: string, effectiveFrom: string, isEnabled: boolean, effectiveTo: string | null = null): VersionRow => ({ module, effectiveFrom, effectiveTo, isEnabled });

describe('summariseModules', () => {
  const today = '2026-10-23';
  it('is on when the version in force is enabled, off when it is disabled or there is none', () => {
    const r = summariseModules(['PF', 'ESI', 'PT'], [v('PF', '2025-04-01', true), v('ESI', '2025-04-01', false)], today);
    expect(r.pf.enabled).toBe(true);
    expect(r.esi.enabled).toBe(false);
    expect(r.pt).toEqual({ enabled: false, nextChangeOn: null });
  });
  it('uses the newest version that has started, ignores ended ones, and reports the next scheduled change', () => {
    const r = summariseModules(['PF'], [v('PF', '2024-04-01', false, '2025-03-31'), v('PF', '2025-04-01', true), v('PF', '2027-04-01', true), v('PF', '2028-04-01', false)], today);
    expect(r.pf).toEqual({ enabled: true, nextChangeOn: '2027-04-01' });
  });
  it('shows a switch-on that has not started yet as off now, with its date', () => {
    expect(summariseModules(['NPS'], [v('NPS', '2026-12-01', true)], today).nps).toEqual({ enabled: false, nextChangeOn: '2026-12-01' });
  });
  it('keys the result by lower-case module name (what the screen uses)', () => {
    expect(Object.keys(summariseModules(['PAYROLL_CALENDAR'], [], today))).toEqual(['payroll_calendar']);
  });
});
