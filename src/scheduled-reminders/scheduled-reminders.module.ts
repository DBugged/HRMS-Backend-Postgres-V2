// Purpose: Wires the scheduled reminder jobs (probation, payroll cut-off, statutory due dates, missed punch-out,
// approval escalation, leave expiry, missing documents, tax declaration, exit clearance) — see each service's header for the schedule and rules.
import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { ReminderNotifier } from './reminder-notifier.service';
import { ProbationReminderService } from './probation-reminder.service';
import { PayrollCutoffReminderService } from './payroll-cutoff-reminder.service';
import { StatutoryDueReminderService } from './statutory-due-reminder.service';
import { MissedPunchOutService } from './missed-punch-out.service';
import { ApprovalEscalationService } from './approval-escalation.service';
import { LeaveExpiryReminderService } from './leave-expiry-reminder.service';
import { MissingDocumentsReminderService } from './missing-documents-reminder.service';
import { TaxDeclarationReminderService } from './tax-declaration-reminder.service';
import { ExitClearanceReminderService } from './exit-clearance-reminder.service';

@Module({
  imports: [NotificationsModule, EmailTemplatesModule, PayrollSettingsModule],
  providers: [
    ReminderNotifier,
    ProbationReminderService,
    PayrollCutoffReminderService,
    StatutoryDueReminderService,
    MissedPunchOutService,
    ApprovalEscalationService,
    LeaveExpiryReminderService,
    MissingDocumentsReminderService,
    TaxDeclarationReminderService,
    ExitClearanceReminderService,
  ],
  exports: [
    ProbationReminderService,
    PayrollCutoffReminderService,
    StatutoryDueReminderService,
    MissedPunchOutService,
    ApprovalEscalationService,
    LeaveExpiryReminderService,
    MissingDocumentsReminderService,
    TaxDeclarationReminderService,
    ExitClearanceReminderService,
  ],
})
export class ScheduledRemindersModule {}
