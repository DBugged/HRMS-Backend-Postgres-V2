import { Module } from '@nestjs/common';
import { PrivacyModule } from '../privacy/privacy.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { CompanyBrandsModule } from '../company-brands/company-brands.module';
import { PayslipPdfService } from './payslip-pdf.service';
import { PayslipEmailQueueService } from './payslip-email-queue.service';
import { PayslipEmailWorker } from './payslip-email.worker';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { StatutoryConfigModule } from '../statutory-config/statutory-config.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { OpeningBalancesController } from './opening-balances.controller';
import { OpeningBalancesService } from './opening-balances.service';
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
    PrivacyModule,
    CompanyBrandsModule,
  ],
  controllers: [PayrollController, OpeningBalancesController],
  providers: [
    PayrollService,
    OpeningBalancesService,
    PayslipPdfService,
    PayslipEmailQueueService,
    PayslipEmailWorker,
  ],
  exports: [PayrollService, PayslipPdfService],
})
export class PayrollModule {}
