import { Module } from '@nestjs/common';
import { WorkLocationsController } from './work-locations.controller';
import { WorkLocationsService } from './work-locations.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [WorkLocationsController],
  providers: [WorkLocationsService],
})
export class WorkLocationsModule {}
