import { Module } from '@nestjs/common';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';
import { OvertimeRuleSetsService } from './overtime-rule-sets.service';
import { OvertimeReportService } from './overtime-report.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalDelegationModule } from '../approval-delegation/approval-delegation.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [
    NotificationsModule,
    ApprovalDelegationModule,
    AuditLogModule,
    EmployeeTimelineModule,
    EmailTemplatesModule,
  ],
  controllers: [OvertimeController],
  providers: [OvertimeService, OvertimeRuleSetsService, OvertimeReportService],
  exports: [OvertimeService],
})
export class OvertimeModule {}
