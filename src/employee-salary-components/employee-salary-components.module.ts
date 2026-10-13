import { Module } from '@nestjs/common';
import { EmployeeSalaryComponentsController } from './employee-salary-components.controller';
import { EmployeeSalaryComponentsService } from './employee-salary-components.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LettersModule } from '../letters/letters.module';

@Module({
  imports: [
    AuditLogModule,
    EmployeeTimelineModule,
    NotificationsModule,
    LettersModule,
  ],
  controllers: [EmployeeSalaryComponentsController],
  providers: [EmployeeSalaryComponentsService],
  // Exported so LeaveEncashmentsModule can inject it for
  // getCurrentMonthlyValue (the "current BASIC" rate calculation).
  exports: [EmployeeSalaryComponentsService],
})
export class EmployeeSalaryComponentsModule {}
