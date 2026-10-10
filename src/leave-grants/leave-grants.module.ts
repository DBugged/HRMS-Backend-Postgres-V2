import { Module } from '@nestjs/common';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { LeaveGrantsController } from './leave-grants.controller';
import { LeaveGrantsService } from './leave-grants.service';

@Module({
  imports: [LeaveBalancesModule, AuditLogModule],
  controllers: [LeaveGrantsController],
  providers: [LeaveGrantsService],
})
export class LeaveGrantsModule {}
