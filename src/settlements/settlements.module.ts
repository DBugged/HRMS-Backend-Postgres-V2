import { Module } from '@nestjs/common';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';
import { PayrollModule } from '../payroll/payroll.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { EmployeeSalaryComponentsModule } from '../employee-salary-components/employee-salary-components.module';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { StatutoryConfigModule } from '../statutory-config/statutory-config.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    PayrollModule,
    StatutoryConfigModule,
    AuditLogModule,
    PayrollSettingsModule,
    EmployeeSalaryComponentsModule,
    LeaveBalancesModule,
    NotificationsModule,
    EmployeeTimelineModule,
    EmailTemplatesModule,
  ],
  controllers: [SettlementsController],
  providers: [SettlementsService],
})
export class SettlementsModule {}
