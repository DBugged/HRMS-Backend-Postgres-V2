// Purpose: The signed token behind a payslip's verification QR code.
// Responsibilities: signs / checks (organizationId, payrollRunId) so the public verification page can tell a payslip this
//   system issued from one somebody typed up; the token carries no pay figures.
// Important: no expiry on purpose - a printed payslip must verify years later. The signature is the same HMAC secret as file
//   tokens; a changed run id or organisation fails the check.
import * as crypto from 'crypto';

function secret(): string {
  const s = process.env.FILE_TOKEN_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error('FILE_TOKEN_SECRET (or JWT_ACCESS_SECRET) must be set to sign payslip tokens.');
  return s;
}

const mac = (body: string) => crypto.createHmac('sha256', secret()).update(`payslip-verify:${body}`).digest('base64url');

export function signPayslipToken(organizationId: string, runId: string): string {
  const body = Buffer.from(`${organizationId}.${runId}`).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function verifyPayslipToken(token: string): { organizationId: string; runId: string } | null {
  const [body, sig, extra] = String(token ?? '').split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = mac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [organizationId, runId] = Buffer.from(body, 'base64url').toString().split('.');
  return organizationId && runId ? { organizationId, runId } : null;
}
