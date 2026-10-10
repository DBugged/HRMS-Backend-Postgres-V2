import { Module } from '@nestjs/common';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { LeaveGrantsController } from './leave-grants.controller';
import { LeaveGrantsService } from './leave-grants.service';
import { LeaveGrantRequestsService } from './leave-grant-requests.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalDelegationModule } from '../approval-delegation/approval-delegation.module';

@Module({
  imports: [
    LeaveBalancesModule,
    AuditLogModule,
    NotificationsModule,
    ApprovalDelegationModule,
  ],
  controllers: [LeaveGrantsController],
  providers: [LeaveGrantsService, LeaveGrantRequestsService],
})
export class LeaveGrantsModule {}
