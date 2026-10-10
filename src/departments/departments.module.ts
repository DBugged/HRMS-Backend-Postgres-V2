import { Module } from '@nestjs/common';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AttendanceModule } from '../attendance/attendance.module';

@Module({
  imports: [AuditLogModule, AttendanceModule],
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
})
export class DepartmentsModule {}
