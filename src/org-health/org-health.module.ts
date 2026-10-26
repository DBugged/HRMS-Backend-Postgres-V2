import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { OrgHealthController } from './org-health.controller';
import { OrgHealthService } from './org-health.service';

@Module({
  imports: [NotificationsModule, PayrollSettingsModule],
  controllers: [OrgHealthController],
  providers: [OrgHealthService],
})
export class OrgHealthModule {}
