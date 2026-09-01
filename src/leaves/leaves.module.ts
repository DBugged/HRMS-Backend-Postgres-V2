import { Module } from '@nestjs/common';
import { LeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { CompOffsModule } from '../comp-offs/comp-offs.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { ApprovalDelegationModule } from '../approval-delegation/approval-delegation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [
    LeaveBalancesModule,
    CompOffsModule,
    AttendanceModule,
    ApprovalDelegationModule,
    NotificationsModule,
    AuditLogModule,
    EmailTemplatesModule,
  ],
  controllers: [LeavesController],
  providers: [LeavesService],
})
export class LeavesModule {}
