import { Module } from '@nestjs/common';
import { FieldTrackingController } from './field-tracking.controller';
import { FieldTrackingService } from './field-tracking.service';
import { FieldVisitsController } from './field-visits.controller';
import { FieldVisitsService } from './field-visits.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';

@Module({
  imports: [AuditLogModule, NotificationsModule, EmployeeTimelineModule],
  controllers: [FieldTrackingController, FieldVisitsController],
  providers: [FieldTrackingService, FieldVisitsService],
  exports: [FieldTrackingService, FieldVisitsService],
})
export class FieldTrackingModule {}
