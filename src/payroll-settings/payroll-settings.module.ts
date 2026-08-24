import { Module } from '@nestjs/common';
import { PayrollSettingsController } from './payroll-settings.controller';
import { PayrollSettingsService } from './payroll-settings.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [PayrollSettingsController],
  providers: [PayrollSettingsService],
  exports: [PayrollSettingsService],
})
export class PayrollSettingsModule {}
