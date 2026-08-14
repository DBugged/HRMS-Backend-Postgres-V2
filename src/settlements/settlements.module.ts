import { Module } from '@nestjs/common';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';
import { PayrollModule } from '../payroll/payroll.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { EmployeeSalaryComponentsModule } from '../employee-salary-components/employee-salary-components.module';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';

@Module({
  imports: [
    PayrollModule,
    PayrollSettingsModule,
    EmployeeSalaryComponentsModule,
    LeaveBalancesModule,
  ],
  controllers: [SettlementsController],
  providers: [SettlementsService],
})
export class SettlementsModule {}
