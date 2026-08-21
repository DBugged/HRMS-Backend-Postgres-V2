import { Module } from '@nestjs/common';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalDelegationModule } from '../approval-delegation/approval-delegation.module';

@Module({
  imports: [NotificationsModule, ApprovalDelegationModule],
  controllers: [OvertimeController],
  providers: [OvertimeService],
  exports: [OvertimeService],
})
export class OvertimeModule {}
