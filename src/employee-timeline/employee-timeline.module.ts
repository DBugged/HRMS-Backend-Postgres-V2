import { Module } from '@nestjs/common';
import { PrivacyModule } from '../privacy/privacy.module';
import { EmployeeTimelineController } from './employee-timeline.controller';
import { EmployeeTimelineService } from './employee-timeline.service';

@Module({
  imports: [PrivacyModule],
  controllers: [EmployeeTimelineController],
  providers: [EmployeeTimelineService],
  exports: [EmployeeTimelineService],
})
export class EmployeeTimelineModule {}
