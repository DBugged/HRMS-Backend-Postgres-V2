import { Module } from '@nestjs/common';
import { EmployeeSalaryComponentsController } from './employee-salary-components.controller';
import { EmployeeSalaryComponentsService } from './employee-salary-components.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { SalaryStructurePdfService } from './salary-structure-pdf.service';
import { PrivacyModule } from '../privacy/privacy.module';

@Module({
  imports: [
    AuditLogModule,
    EmployeeTimelineModule,
    NotificationsModule,
    EmailTemplatesModule,
    PrivacyModule,
  ],
  controllers: [EmployeeSalaryComponentsController],
  providers: [EmployeeSalaryComponentsService, SalaryStructurePdfService],
  // Exported so LeaveEncashmentsModule can inject it for
  // getCurrentMonthlyValue (the "current BASIC" rate calculation).
  exports: [EmployeeSalaryComponentsService],
})
export class EmployeeSalaryComponentsModule {}
