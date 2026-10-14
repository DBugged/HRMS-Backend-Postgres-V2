import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { SelfieStampService } from './selfie-stamp.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { ApprovalDelegationModule } from '../approval-delegation/approval-delegation.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    NotificationsModule,
    EmployeeTimelineModule,
    ApprovalDelegationModule,
    EmailTemplatesModule,
    AuditLogModule,
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService, SelfieStampService],
  // Exported so LeavesModule can inject AttendanceService for the
  // approval/cancellation integration hooks.
  exports: [AttendanceService],
})
export class AttendanceModule {}
