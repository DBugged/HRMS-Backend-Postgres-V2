import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { CompOffsModule } from '../comp-offs/comp-offs.module';
import { StatutoryConfigModule } from '../statutory-config/statutory-config.module';

@Module({
  imports: [PayrollSettingsModule, CompOffsModule, StatutoryConfigModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
