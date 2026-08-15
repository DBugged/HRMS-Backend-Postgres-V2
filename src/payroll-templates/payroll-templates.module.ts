import { Module } from '@nestjs/common';
import { PayrollTemplatesController } from './payroll-templates.controller';
import { PayrollTemplatesService } from './payroll-templates.service';
import { PayrollModule } from '../payroll/payroll.module';

@Module({
  imports: [PayrollModule],
  controllers: [PayrollTemplatesController],
  providers: [PayrollTemplatesService],
})
export class PayrollTemplatesModule {}
