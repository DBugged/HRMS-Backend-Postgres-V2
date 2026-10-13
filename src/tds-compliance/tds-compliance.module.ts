import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { TdsComplianceController } from './tds-compliance.controller';
import { TdsComplianceService } from './tds-compliance.service';

import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditLogModule, PrivacyModule, NotificationsModule],
  controllers: [TdsComplianceController],
  providers: [TdsComplianceService],
})
export class TdsComplianceModule {}
