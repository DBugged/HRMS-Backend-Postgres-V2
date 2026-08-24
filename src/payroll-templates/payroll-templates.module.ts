import { Module } from '@nestjs/common';
import { PayrollTemplatesController } from './payroll-templates.controller';
import { PayrollTemplatesService } from './payroll-templates.service';
import { PayrollModule } from '../payroll/payroll.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [PayrollModule, AuditLogModule],
  controllers: [PayrollTemplatesController],
  providers: [PayrollTemplatesService],
})
export class PayrollTemplatesModule {}
