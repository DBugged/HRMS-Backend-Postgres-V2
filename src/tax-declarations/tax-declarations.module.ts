import { Module } from '@nestjs/common';
import { TaxDeclarationsController } from './tax-declarations.controller';
import { TaxDeclarationsService } from './tax-declarations.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';

@Module({
  imports: [
    NotificationsModule,
    AuditLogModule,
    EmployeeTimelineModule,
    EmailTemplatesModule,
    PayrollSettingsModule,
  ],
  controllers: [TaxDeclarationsController],
  providers: [TaxDeclarationsService],
})
export class TaxDeclarationsModule {}
