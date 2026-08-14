import { Module } from '@nestjs/common';
import { PayrollTemplatesController } from './payroll-templates.controller';
import { PayrollTemplatesService } from './payroll-templates.service';

@Module({
  controllers: [PayrollTemplatesController],
  providers: [PayrollTemplatesService],
})
export class PayrollTemplatesModule {}
