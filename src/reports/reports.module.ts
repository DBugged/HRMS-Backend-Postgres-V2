import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PayrollReportsController } from './payroll-reports.controller';
import { PayrollReportsService } from './payroll-reports.service';
import { CustomReportController } from './custom-report.controller';
import { CustomReportService } from './custom-report.service';
import { EcrController } from './ecr.controller';
import { EcrService } from './ecr.service';
import { StatutoryReturnsController } from './statutory-returns.controller';
import { StatutoryReturnsService } from './statutory-returns.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { PrivacyModule } from '../privacy/privacy.module';

@Module({
  imports: [DashboardModule, PrivacyModule],
  controllers: [
    ReportsController,
    PayrollReportsController,
    CustomReportController,
    EcrController,
    StatutoryReturnsController,
  ],
  providers: [
    ReportsService,
    PayrollReportsService,
    CustomReportService,
    EcrService,
    StatutoryReturnsService,
  ],
})
export class ReportsModule {}
