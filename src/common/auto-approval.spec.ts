import { compOffQualifies, overtimeQualifies, readAutoApproval, reimbursementQualifies } from './auto-approval';

describe('auto-approval rules', () => {
  it('everything is off by default', () => {
    const r = readAutoApproval(null);
    expect(r.overtime.on || r.compOff.on || r.reimbursement.on).toBe(false);
    expect(overtimeQualifies(r.overtime, 1, 0)).toBe(false);
    expect(compOffQualifies(r.compOff, 1)).toBe(false);
    expect(reimbursementQualifies(r.reimbursement, 10, true)).toBe(false);
  });

  it('overtime qualifies only within the monthly cap, and a cap of 0 approves nothing', () => {
    const on = readAutoApproval({ autoApproveOvertime: true, autoApproveOvertimeMonthlyCapHours: 10 }).overtime;
    expect(overtimeQualifies(on, 2, 8)).toBe(true);
    expect(overtimeQualifies(on, 2.5, 8)).toBe(false);
    expect(overtimeQualifies(readAutoApproval({ autoApproveOvertime: true }).overtime, 1, 0)).toBe(false);
  });

  it('comp-off qualifies up to the allowed days (default 1)', () => {
    const def = readAutoApproval({ autoApproveCompOff: true }).compOff;
    expect(compOffQualifies(def, 1)).toBe(true);
    expect(compOffQualifies(def, 2)).toBe(false);
    expect(compOffQualifies(readAutoApproval({ autoApproveCompOff: true, autoApproveCompOffMaxDays: 2 }).compOff, 2)).toBe(true);
  });

  it('a reimbursement needs a receipt and an amount within the limit', () => {
    const r = readAutoApproval({ autoApproveReimbursement: true, autoApproveReimbursementMaxAmount: 500 }).reimbursement;
    expect(reimbursementQualifies(r, 500, true)).toBe(true);
    expect(reimbursementQualifies(r, 501, true)).toBe(false);
    expect(reimbursementQualifies(r, 100, false)).toBe(false);
    expect(reimbursementQualifies(readAutoApproval({ autoApproveReimbursement: true }).reimbursement, 1, true)).toBe(false);
  });

  it('ignores non-boolean or non-numeric values', () => {
    const r = readAutoApproval({ autoApproveOvertime: 'yes', autoApproveOvertimeMonthlyCapHours: '10' });
    expect(r.overtime.on).toBe(false);
    expect(r.overtime.monthlyCapHours).toBe(0);
  });
});
