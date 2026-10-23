import { employeeLimit, monthlyCharge } from './cc-util';
import { toCsv } from './cc-reports.service';

// The price sheet's rules, as the panel applies them. Rates are per employee per month, GST extra.
const starter = { perEmployeeRate: 120, perExtraEmployeeRate: 130, includedEmployees: 50, limits: { annualRate: 110 } };
const enterprise = { perEmployeeRate: null, perExtraEmployeeRate: null, includedEmployees: null, limits: { custom: true } };

describe('monthlyCharge', () => {
  it('bills employees x rate within the plan size', () => {
    expect(monthlyCharge(starter, 'MONTHLY', 5, null)).toBe(600);
  });
  it('uses the discounted annual rate on a yearly term', () => {
    expect(monthlyCharge(starter, 'YEARLY', 10, null)).toBe(1100);
  });
  it('charges the extra rate only for employees above the plan size', () => {
    expect(monthlyCharge(starter, 'MONTHLY', 60, null)).toBe(50 * 120 + 10 * 130);
  });
  it('has no automatic price for a custom plan until a rate is agreed', () => {
    expect(monthlyCharge(enterprise, 'MONTHLY', 10, null)).toBeNull();
    expect(monthlyCharge(enterprise, 'MONTHLY', 10, 95)).toBe(950);
  });
  it('lets a negotiated rate override the plan, including above the cap', () => {
    expect(monthlyCharge(starter, 'MONTHLY', 60, 100)).toBe(6000);
  });
  it('is zero with no employees', () => {
    expect(monthlyCharge(starter, 'MONTHLY', 0, null)).toBe(0);
  });
});

describe('employeeLimit', () => {
  it('reports how far over the plan an organization is', () => {
    expect(employeeLimit(starter, 57)).toEqual({ used: 57, included: 50, overBy: 7, hasOverageRate: true, blockAt: null });
    expect(employeeLimit(starter, 20)?.overBy).toBe(0);
  });
  it('has no limit on a plan without a size', () => {
    expect(employeeLimit(enterprise, 500)).toBeNull();
  });
  it('carries the hard limit a Super Admin set, and uses it when the plan has no size', () => {
    expect(employeeLimit(starter, 40, 45)?.blockAt).toBe(45);
    expect(employeeLimit(enterprise, 120, 100)).toEqual({ used: 120, included: 100, overBy: 20, hasOverageRate: false, blockAt: 100 });
  });
});

describe('toCsv', () => {
  it('quotes cells and doubles embedded quotes', () => {
    expect(toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }])).toBe('a,b\n"x,y","say ""hi"""');
  });
});
