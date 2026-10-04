import { Module } from '@nestjs/common';
import { StatutoryConfigController } from './statutory-config.controller';
import { StatutoryConfigService } from './statutory-config.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { StatutorySourceMonitorService } from './statutory-source-monitor.service';

@Module({
  imports: [AuditLogModule],
  controllers: [StatutoryConfigController],
  providers: [StatutoryConfigService, StatutorySourceMonitorService],
  exports: [StatutoryConfigService],
})
export class StatutoryConfigModule {}
