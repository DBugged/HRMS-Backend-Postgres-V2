import { Module } from '@nestjs/common';
import { EmployeeSalaryComponentsController } from './employee-salary-components.controller';
import { EmployeeSalaryComponentsService } from './employee-salary-components.service';

@Module({
  controllers: [EmployeeSalaryComponentsController],
  providers: [EmployeeSalaryComponentsService],
  // Exported so LeaveEncashmentsModule can inject it for
  // getCurrentMonthlyValue (the "current BASIC" rate calculation).
  exports: [EmployeeSalaryComponentsService],
})
export class EmployeeSalaryComponentsModule {}
