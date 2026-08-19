import { Module } from '@nestjs/common';
import { LeaveEncashmentsController } from './leave-encashments.controller';
import { LeaveEncashmentsService } from './leave-encashments.service';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { EmployeeSalaryComponentsModule } from '../employee-salary-components/employee-salary-components.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    LeaveBalancesModule,
    PayrollSettingsModule,
    EmployeeSalaryComponentsModule,
    NotificationsModule,
  ],
  controllers: [LeaveEncashmentsController],
  providers: [LeaveEncashmentsService],
})
export class LeaveEncashmentsModule {}
