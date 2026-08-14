import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  // Exported so LeavesModule can inject AttendanceService for the
  // approval/cancellation integration hooks.
  exports: [AttendanceService],
})
export class AttendanceModule {}
