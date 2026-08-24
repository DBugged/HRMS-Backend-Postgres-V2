import { Module } from '@nestjs/common';
import { CompOffController } from './comp-off.controller';
import { CompOffService } from './comp-off.service';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalDelegationModule } from '../approval-delegation/approval-delegation.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';

@Module({
  imports: [
    PayrollSettingsModule,
    NotificationsModule,
    ApprovalDelegationModule,
    AuditLogModule,
    EmployeeTimelineModule,
  ],
  controllers: [CompOffController],
  providers: [CompOffService],
  exports: [CompOffService],
})
export class CompOffsModule {}
