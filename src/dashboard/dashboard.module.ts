import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { CompOffsModule } from '../comp-offs/comp-offs.module';

@Module({
  imports: [PayrollSettingsModule, CompOffsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
