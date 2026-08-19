import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeeProfileService } from './employee-profile.service';
import { EmployeeIdService } from './employee-id.service';
import { UsersModule } from '../users/users.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [UsersModule, EmployeeTimelineModule, NotificationsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeProfileService, EmployeeIdService],
  // EmployeeIdService is exported specifically so AuthModule can reuse it
  // for founder-account creation (the founder is Employee #1 of their own
  // org) instead of duplicating the row-locked counter logic.
  exports: [EmployeeIdService],
})
export class EmployeesModule {}
