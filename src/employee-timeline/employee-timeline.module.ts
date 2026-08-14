import { Module } from '@nestjs/common';
import { EmployeeTimelineController } from './employee-timeline.controller';
import { EmployeeTimelineService } from './employee-timeline.service';

@Module({
  controllers: [EmployeeTimelineController],
  providers: [EmployeeTimelineService],
  exports: [EmployeeTimelineService],
})
export class EmployeeTimelineModule {}
