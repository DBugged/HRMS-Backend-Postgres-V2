// Purpose: The public page a payslip's QR code opens - "is this payslip genuine?".
// Responsibilities: GET /verify/payslip/:token (no sign-in) checks the signed token, looks the payslip up and shows who and
//   which month it was issued for. It never shows pay figures: whoever holds the paper already has them.
// Important: a self-contained HTML page served by the backend, so it works without knowing the web app's address. Everything
//   printed is HTML-escaped; unknown or tampered tokens get the same "could not be verified" page.
import { Controller, Get, Header, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PayrollRunStatus } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { verifyPayslipToken } from './payslip-verify-token';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ISSUED: PayrollRunStatus[] = [PayrollRunStatus.APPROVED, PayrollRunStatus.LOCKED, PayrollRunStatus.PAID];

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(ok: boolean, title: string, rows: [string, string][], note: string): string {
  const color = ok ? '#067647' : '#b42318';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Payslip verification</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7fb;color:#14161d;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border:1px solid #e4e7ec;border-radius:16px;max-width:420px;width:100%;padding:28px}
.badge{display:inline-flex;align-items:center;gap:8px;font-weight:600;color:${color};background:${ok ? '#ecfdf3' : '#fef3f2'};border-radius:999px;padding:6px 14px;font-size:14px}
h1{font-size:20px;margin:16px 0 4px}dl{margin:16px 0 0}dt{font-size:12px;color:#667085;margin-top:12px}dd{margin:2px 0 0;font-weight:600}
p{font-size:12px;color:#667085;margin:20px 0 0;line-height:1.5}</style></head>
<body><main><span class="badge">${ok ? '&#10003; Verified' : '&#10007; Not verified'}</span><h1>${esc(title)}</h1>
${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}<p>${esc(note)}</p></main></body></html>`;
}

@Controller('verify')
export class PayslipVerifyController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('payslip/:token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async payslip(@Param('token') token: string): Promise<string> {
    const claim = verifyPayslipToken(token);
    const run = claim
      ? await this.prisma.payrollRun.findFirst({
          where: { id: claim.runId, organizationId: claim.organizationId },
          select: {
            month: true, year: true, status: true, isFinalSettlement: true,
            employee: { select: { name: true, employeeId: true } },
            organization: { select: { name: true } },
          },
        })
      : null;
    if (!run) {
      return page(false, 'This payslip could not be verified', [], 'The code is not recognised. Check that the payslip is the original, or ask the company\'s HR to confirm it.');
    }
    if (!ISSUED.includes(run.status)) {
      return page(false, 'Not issued yet', [['Company', run.organization.name]], 'This payslip has not been finalised by the company, so it cannot be verified yet.');
    }
    return page(
      true,
      run.isFinalSettlement ? 'Genuine final settlement payslip' : 'Genuine payslip',
      [
        ['Company', run.organization.name],
        ['Employee', run.employee.name],
        ['Employee ID', run.employee.employeeId],
        ['Pay period', `${MONTHS[run.month - 1]} ${run.year}`],
      ],
      'Issued by this company\'s payroll system. Pay amounts are not shown here; compare the details above with your copy.',
    );
  }
}
