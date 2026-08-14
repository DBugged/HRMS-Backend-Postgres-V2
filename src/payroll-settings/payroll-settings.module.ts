import { Module } from '@nestjs/common';
import { PayrollSettingsController } from './payroll-settings.controller';
import { PayrollSettingsService } from './payroll-settings.service';

@Module({
  controllers: [PayrollSettingsController],
  providers: [PayrollSettingsService],
  exports: [PayrollSettingsService],
})
export class PayrollSettingsModule {}
