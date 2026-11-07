import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { LeavesModule } from '../leaves/leaves.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MyRequestsController } from './my-requests.controller';
import { MyRequestsService } from './my-requests.service';

@Module({
  imports: [AuditLogModule, AttendanceModule, LeavesModule, ModuleAccessModule, NotificationsModule],
  controllers: [MyRequestsController],
  providers: [MyRequestsService],
})
export class MyRequestsModule {}
