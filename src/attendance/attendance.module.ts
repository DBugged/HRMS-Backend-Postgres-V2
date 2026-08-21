import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { ApprovalDelegationModule } from '../approval-delegation/approval-delegation.module';

@Module({
  imports: [
    NotificationsModule,
    EmployeeTimelineModule,
    ApprovalDelegationModule,
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  // Exported so LeavesModule can inject AttendanceService for the
  // approval/cancellation integration hooks.
  exports: [AttendanceService],
})
export class AttendanceModule {}
