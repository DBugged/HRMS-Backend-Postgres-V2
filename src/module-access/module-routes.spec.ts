import { moduleForPath } from './module-routes';

describe('moduleForPath', () => {
  it('maps module routes to their flag', () => {
    expect(moduleForPath('/payroll/runs')).toBe('module.payroll');
    expect(moduleForPath('/leave-balances/me?year=2026')).toBe('module.leave');
    expect(moduleForPath('/tds/summary')).toBe('module.statutory');
    expect(moduleForPath('/employees/abc/letters')).toBe('module.documents_letters');
    expect(moduleForPath('/dashboard/hr/payroll-cost-summary?range=this_year')).toBe('module.payroll');
  });
  it('leaves core routes alone', () => {
    expect(moduleForPath('/employees')).toBeNull();
    expect(moduleForPath('/auth/me')).toBeNull();
    expect(moduleForPath('/modules')).toBeNull();
    expect(moduleForPath('/dashboard/hr')).toBeNull();
    expect(moduleForPath('/dashboard/pending-counts')).toBeNull();
    expect(moduleForPath('/')).toBeNull();
  });
});
