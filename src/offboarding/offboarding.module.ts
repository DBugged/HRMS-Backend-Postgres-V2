import { Module } from '@nestjs/common';
import { OffboardingController } from './offboarding.controller';
import { OffboardingService } from './offboarding.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [AuditLogModule, EmployeeTimelineModule, NotificationsModule, EmailTemplatesModule],
  controllers: [OffboardingController],
  providers: [OffboardingService],
})
export class OffboardingModule {}
