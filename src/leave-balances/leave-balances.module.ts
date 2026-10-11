import { Module } from '@nestjs/common';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveAccrualService } from './leave-accrual.service';
import { LeaveBalanceAdjustmentService } from './leave-balance-adjustment.service';
import { LeaveBalancesController } from './leave-balances.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [LeaveBalancesController],
  providers: [
    LeaveBalanceService,
    LeaveAccrualService,
    LeaveBalanceAdjustmentService,
  ],
  exports: [LeaveBalanceService, LeaveAccrualService],
})
export class LeaveBalancesModule {}
