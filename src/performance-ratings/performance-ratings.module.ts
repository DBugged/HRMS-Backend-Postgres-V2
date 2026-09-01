import { Module } from '@nestjs/common';
import { PerformanceRatingsController } from './performance-ratings.controller';
import { PerformanceRatingsService } from './performance-ratings.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [NotificationsModule, AuditLogModule, EmployeeTimelineModule, EmailTemplatesModule],
  controllers: [PerformanceRatingsController],
  providers: [PerformanceRatingsService],
  exports: [PerformanceRatingsService],
})
export class PerformanceRatingsModule {}
