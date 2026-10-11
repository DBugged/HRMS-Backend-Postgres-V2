import { Module } from '@nestjs/common';
import { LeaveTypesController } from './leave-types.controller';
import { LeaveTypesService } from './leave-types.service';
import { LeaveYearController } from './leave-year.controller';
import { LeaveYearService } from './leave-year.service';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [LeaveBalancesModule, AuditLogModule],
  controllers: [LeaveTypesController, LeaveYearController],
  providers: [LeaveTypesService, LeaveYearService],
  exports: [LeaveTypesService, LeaveYearService],
})
export class LeaveTypesModule {}
