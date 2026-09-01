import { Module } from '@nestjs/common';
import { LeaveEncashmentsController } from './leave-encashments.controller';
import { LeaveEncashmentsService } from './leave-encashments.service';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { EmployeeSalaryComponentsModule } from '../employee-salary-components/employee-salary-components.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [
    LeaveBalancesModule,
    PayrollSettingsModule,
    EmployeeSalaryComponentsModule,
    NotificationsModule,
    AuditLogModule,
    EmployeeTimelineModule,
    EmailTemplatesModule,
  ],
  controllers: [LeaveEncashmentsController],
  providers: [LeaveEncashmentsService],
})
export class LeaveEncashmentsModule {}
