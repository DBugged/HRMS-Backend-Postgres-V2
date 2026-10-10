import { Module } from '@nestjs/common';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { LeaveGrantsController } from './leave-grants.controller';
import { LeaveGrantsService } from './leave-grants.service';
import { LeaveGrantRequestsService } from './leave-grant-requests.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [LeaveBalancesModule, AuditLogModule, NotificationsModule],
  controllers: [LeaveGrantsController],
  providers: [LeaveGrantsService, LeaveGrantRequestsService],
})
export class LeaveGrantsModule {}
