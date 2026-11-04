import { Module } from '@nestjs/common';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';
import { ShiftRulesController } from './shift-rules.controller';
import { ShiftRulesService } from './shift-rules.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AttendanceModule } from '../attendance/attendance.module';

@Module({
  imports: [AuditLogModule, AttendanceModule],
  controllers: [WorkSchedulesController, ShiftRulesController],
  providers: [WorkSchedulesService, ShiftRulesService],
  exports: [WorkSchedulesService],
})
export class WorkSchedulesModule {}
