// Purpose: the "after the last working day" housekeeping for a leaver, done by the system so HR does not have to chase it.
// Responsibilities (each runs once per case, the morning after the last working day, and is safe to retry):
//   - clearPending: cancels the leaver's pending leave requests, closes their pending loan/advance requests, ends the
//     approval delegations they gave or received, and tells HR about what only a person can decide (leave-encashment
//     requests cannot be rejected, so they are left for the settlement). Stamps pendingClearedAt.
//   - sendExitPack: emails the last six payslips (PDF) to the personal email, since sign-in to the work account has ended.
//     Stamps exitPackSentAt; nothing is sent (and HR is told) when there is no personal email or no payslip yet.
// Important: only things that are safe to undo-by-nobody are closed - nothing money-related is approved or paid here.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LeaveStatus, LeaveEncashmentStatus, LoanStatus, PayrollRunStatus, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { EmailService } from '../notifications/email.service';
import type { EmailAttachment } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { LeavesService } from '../leaves/leaves.service';
import { LoansService } from '../loans/loans.service';
import { PayslipPdfService } from '../payroll/payslip-pdf.service';
import { personalEmailOf } from '../common/personal-email';
import { dmyText } from '../payroll/format-date';
import { OffboardingService } from './offboarding.service';

type Actor = Omit<User, 'password'>;

export interface ExitCase {
  id: string;
  employeeId: string;
  lastWorkingDay: string;
  initiatedById: string;
  employee: { name: string; employeeId: string };
}

export const LOAN_CLOSED_REASON = 'Closed automatically because the employee has left the company.';
const PAYSLIPS_IN_PACK = 6;

@Injectable()
export class ExitClosureService {
  private readonly logger = new Logger(ExitClosureService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly offboarding: OffboardingService,
    private readonly leaves: LeavesService,
    private readonly loans: LoansService,
    private readonly payslipPdf: PayslipPdfService,
    private readonly emailService: EmailService,
    private readonly emailTemplates: EmailTemplatesService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
  ) {}

  // Returns what was closed. A failure on one request is logged and counted as "left for HR", never thrown.
  async clearPending(c: ExitCase, actor: Actor, organizationId: string) {
    let leavesCancelled = 0;
    let loansClosed = 0;
    let leftForHr = 0;

    const pendingLeaves = await this.scopedPrisma.leave.findMany({
      where: { organizationId, employeeId: c.employeeId, status: { in: [LeaveStatus.PENDING, LeaveStatus.RETURNED] } },
      select: { id: true },
    });
    for (const l of pendingLeaves) {
      try {
        await this.leaves.cancel(l.id, actor, organizationId);
        leavesCancelled++;
      } catch (err) {
        leftForHr++;
        this.logger.warn(`Leave ${l.id} of ${c.employeeId} not cancelled: ${(err as Error).message}`);
      }
    }

    const pendingLoans = await this.scopedPrisma.loan.findMany({
      where: { organizationId, employeeId: c.employeeId, status: LoanStatus.PENDING },
      select: { id: true },
    });
    for (const l of pendingLoans) {
      try {
        await this.loans.reject(l.id, { reason: LOAN_CLOSED_REASON } as never, actor, organizationId);
        loansClosed++;
      } catch (err) {
        leftForHr++;
        this.logger.warn(`Loan ${l.id} of ${c.employeeId} not closed: ${(err as Error).message}`);
      }
    }

    // Encashment cannot be rejected (only pending/approved/processed exist), so HR settles it with the final settlement.
    const encashments = await this.scopedPrisma.leaveEncashment.count({
      where: { organizationId, employeeId: c.employeeId, status: LeaveEncashmentStatus.PENDING },
    });
    leftForHr += encashments;

    // Approvals the leaver gave or received by delegation end with their last working day.
    const ended = await this.scopedPrisma.approvalDelegation.updateMany({
      where: { organizationId, isActive: true, OR: [{ delegatorId: c.employeeId }, { delegateId: c.employeeId }] },
      data: { isActive: false },
    });

    await this.scopedPrisma.offboardingCase.updateMany({ where: { id: c.id, organizationId }, data: { pendingClearedAt: new Date() } });

    const parts = [
      leavesCancelled && `${leavesCancelled} pending leave request(s) cancelled`,
      loansClosed && `${loansClosed} pending loan request(s) closed`,
      ended.count && `${ended.count} approval delegation(s) ended`,
    ].filter(Boolean) as string[];
    if (parts.length > 0) {
      await this.record(organizationId, actor, c, 'EXIT_PENDING_CLEARED', `${parts.join(', ')} because ${c.employee.name} has left.`);
    }
    if (leftForHr > 0) {
      await this.offboarding.notifyHr(
        organizationId,
        [c.initiatedById],
        `Requests still open for ${c.employee.name}`,
        `${c.employee.name} (${c.employee.employeeId}) left on ${dmyText(c.lastWorkingDay)} and ${leftForHr} request(s) (such as leave encashment) need a decision. Settle them with the final settlement.`,
      );
    }
    return { leavesCancelled, loansClosed, delegationsEnded: ended.count, leftForHr };
  }

  // True when the pack was emailed. Silent skip is avoided: HR is told why nothing went out.
  async sendExitPack(c: ExitCase, actor: Actor, organizationId: string): Promise<boolean> {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: c.employeeId, organizationId },
      select: { name: true, personalData: true },
    });
    const to = personalEmailOf(employee?.personalData);
    if (!employee || !to) {
      await this.offboarding.notifyHr(
        organizationId,
        [c.initiatedById],
        `Exit documents not emailed: ${c.employee.name}`,
        `${c.employee.name} has no personal email on file, so the last payslips could not be sent. Add it to their profile; the documents then go out automatically.`,
      );
      return false;
    }
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: { organizationId, employeeId: c.employeeId, status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: PAYSLIPS_IN_PACK,
      select: { id: true },
    });
    const attachments: EmailAttachment[] = [];
    for (const r of runs) {
      try {
        const { buffer, filename } = await this.payslipPdf.buildPayslipPdfBuffer(r.id, organizationId);
        attachments.push({ filename, content: buffer });
      } catch (err) {
        this.logger.warn(`Payslip ${r.id} not attached for ${c.employeeId}: ${(err as Error).message}`);
      }
    }
    if (attachments.length === 0) return false;

    const variables = { employeeName: employee.name, lastWorkingDay: dmyText(c.lastWorkingDay), payslipCount: String(attachments.length) };
    const rendered = await this.emailTemplates.renderOccasion(
      organizationId,
      'EXIT_DOCUMENTS_PACK',
      variables,
      this.emailTemplates.defaultFor('EXIT_DOCUMENTS_PACK', variables),
    );
    await this.emailService.send({ organizationId, to, subject: rendered.subject, html: rendered.html, attachments });
    await this.scopedPrisma.offboardingCase.updateMany({ where: { id: c.id, organizationId }, data: { exitPackSentAt: new Date() } });
    await this.record(organizationId, actor, c, 'EXIT_PACK_EMAILED', `The last ${attachments.length} payslip(s) were emailed to the personal email address.`);
    return true;
  }

  private async record(organizationId: string, actor: Actor, c: ExitCase, action: string, description: string) {
    await this.auditLogService.log({
      actorId: actor.id,
      action,
      module: 'EMPLOYEE',
      organizationId,
      targetId: c.employeeId,
      details: { offboardingCaseId: c.id, automatic: true },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: c.employeeId,
      eventKey: 'EMPLOYEE_UPDATED',
      performedById: actor.id,
      description: `${description} (done automatically by the system)`,
    });
  }
}
