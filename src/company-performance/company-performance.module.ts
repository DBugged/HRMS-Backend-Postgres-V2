import { Module } from '@nestjs/common';
import { CompanyPerformanceController } from './company-performance.controller';
import { CompanyPerformanceService } from './company-performance.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [CompanyPerformanceController],
  providers: [CompanyPerformanceService],
})
export class CompanyPerformanceModule {}
