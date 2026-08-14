import { Module } from '@nestjs/common';
import { LeaveBalanceService } from './leave-balance.service';

@Module({
  providers: [LeaveBalanceService],
  exports: [LeaveBalanceService],
})
export class LeaveBalancesModule {}
