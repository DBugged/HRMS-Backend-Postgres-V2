import { Module } from '@nestjs/common';
import { WeeklyOffPatternsController } from './weekly-off-patterns.controller';
import { WeeklyOffPatternsService } from './weekly-off-patterns.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [WeeklyOffPatternsController],
  providers: [WeeklyOffPatternsService],
  exports: [WeeklyOffPatternsService],
})
export class WeeklyOffPatternsModule {}
