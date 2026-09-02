import { Module } from '@nestjs/common';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { PayslipPdfService } from './payslip-pdf.service';
import { PayslipEmailQueueService } from './payslip-email-queue.service';
import { PayslipEmailWorker } from './payslip-email.worker';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { StatutoryConfigModule } from '../statutory-config/statutory-config.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { LoansModule } from '../loans/loans.module';

@Module({
  imports: [
    PayrollSettingsModule,
    StatutoryConfigModule,
    AuditLogModule,
    EmployeeTimelineModule,
    NotificationsModule,
    EmailTemplatesModule,
    LoansModule,
  ],
  controllers: [PayrollController],
  providers: [
    PayrollService,
    PayslipPdfService,
    PayslipEmailQueueService,
    PayslipEmailWorker,
  ],
  exports: [PayrollService, PayslipPdfService],
})
export class PayrollModule {}
