import { Module } from '@nestjs/common';
import { SalaryComponentsController } from './salary-components.controller';
import { SalaryComponentsService } from './salary-components.service';

@Module({
  controllers: [SalaryComponentsController],
  providers: [SalaryComponentsService],
})
export class SalaryComponentsModule {}
