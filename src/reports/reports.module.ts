import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PayrollReportsController } from './payroll-reports.controller';
import { PayrollReportsService } from './payroll-reports.service';
import { CustomReportController } from './custom-report.controller';
import { CustomReportService } from './custom-report.service';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
  imports: [DashboardModule],
  controllers: [
    ReportsController,
    PayrollReportsController,
    CustomReportController,
  ],
  providers: [ReportsService, PayrollReportsService, CustomReportService],
})
export class ReportsModule {}
