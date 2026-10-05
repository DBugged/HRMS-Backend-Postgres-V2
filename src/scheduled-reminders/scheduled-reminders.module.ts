// Purpose: Wires the scheduled reminder jobs (probation, payroll cut-off, statutory due dates, missed punch-out,
// approval escalation) — see each service's header for the schedule and rules.
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

@Module({
  imports: [NotificationsModule, EmailTemplatesModule, PayrollSettingsModule],
  providers: [
    ReminderNotifier,
    ProbationReminderService,
    PayrollCutoffReminderService,
    StatutoryDueReminderService,
    MissedPunchOutService,
    ApprovalEscalationService,
  ],
  exports: [
    ProbationReminderService,
    PayrollCutoffReminderService,
    StatutoryDueReminderService,
    MissedPunchOutService,
    ApprovalEscalationService,
  ],
})
export class ScheduledRemindersModule {}
