import { signPayslipToken, verifyPayslipToken } from './payslip-verify-token';

describe('payslip verification token', () => {
  beforeAll(() => { process.env.FILE_TOKEN_SECRET = 'test-secret'; });

  it('round-trips the organisation and run', () => {
    const t = signPayslipToken('org-1', 'run-1');
    expect(verifyPayslipToken(t)).toEqual({ organizationId: 'org-1', runId: 'run-1' });
  });

  it('rejects a changed body or signature', () => {
    const [body, sig] = signPayslipToken('org-1', 'run-1').split('.');
    const other = Buffer.from('org-1.run-2').toString('base64url');
    expect(verifyPayslipToken(`${other}.${sig}`)).toBeNull();
    expect(verifyPayslipToken(`${body}.${sig}x`)).toBeNull();
  });

  it('rejects junk', () => {
    expect(verifyPayslipToken('')).toBeNull();
    expect(verifyPayslipToken('abc')).toBeNull();
    expect(verifyPayslipToken('a.b.c')).toBeNull();
  });
});
