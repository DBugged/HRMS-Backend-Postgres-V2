import { Module } from '@nestjs/common';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveAccrualService } from './leave-accrual.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  providers: [LeaveBalanceService, LeaveAccrualService],
  exports: [LeaveBalanceService, LeaveAccrualService],
})
export class LeaveBalancesModule {}
