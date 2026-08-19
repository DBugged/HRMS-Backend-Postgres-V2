import { Module } from '@nestjs/common';
import { ReimbursementsController } from './reimbursements.controller';
import { ReimbursementsService } from './reimbursements.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [ReimbursementsController],
  providers: [ReimbursementsService],
})
export class ReimbursementsModule {}
