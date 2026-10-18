import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PayrollReportsController } from './payroll-reports.controller';
import { PayrollReportsService } from './payroll-reports.service';
import { CustomReportController } from './custom-report.controller';
import { CustomReportService } from './custom-report.service';
import { ScheduledReportsController } from './scheduled-reports.controller';
import { ScheduledReportsService } from './scheduled-reports.service';
import { OpsReportsController } from './ops-reports.controller';
import { OpsReportsService } from './ops-reports.service';
import { EcrController } from './ecr.controller';
import { EcrService } from './ecr.service';
import { StatutoryReturnsController } from './statutory-returns.controller';
import { StatutoryReturnsService } from './statutory-returns.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    DashboardModule,
    PrivacyModule,
    NotificationsModule,
    AuditLogModule,
  ],
  controllers: [
    ReportsController,
    PayrollReportsController,
    CustomReportController,
    EcrController,
    OpsReportsController,
    ScheduledReportsController,
    StatutoryReturnsController,
  ],
  providers: [
    ReportsService,
    PayrollReportsService,
    CustomReportService,
    EcrService,
    OpsReportsService,
    ScheduledReportsService,
    StatutoryReturnsService,
  ],
})
export class ReportsModule {}
