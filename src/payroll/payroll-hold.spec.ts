import { redactHoldForEmployee } from './payroll-hold';

describe('redactHoldForEmployee', () => {
  it('keeps that the salary is on hold but removes the reason and who held it', () => {
    const held = new Date('2026-10-02T10:00:00Z');
    const out = redactHoldForEmployee({
      id: 'r1',
      netPay: 50000,
      heldAt: held,
      heldById: 'hr1',
      holdReason: 'Disciplinary inquiry',
    });
    expect(out).toEqual({
      id: 'r1',
      netPay: 50000,
      heldAt: held,
      heldById: null,
      holdReason: null,
    });
  });

  it('does not change the original row', () => {
    const run = { heldById: 'hr1', holdReason: 'x' };
    redactHoldForEmployee(run);
    expect(run.holdReason).toBe('x');
  });
});
