import { Module } from '@nestjs/common';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [WorkSchedulesController],
  providers: [WorkSchedulesService],
  exports: [WorkSchedulesService],
})
export class WorkSchedulesModule {}
