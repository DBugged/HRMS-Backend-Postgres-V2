import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { JoiningController } from './joining.controller';
import { JoiningChecklistService } from './joining-checklist.service';

@Module({
  imports: [NotificationsModule],
  controllers: [JoiningController],
  providers: [JoiningChecklistService],
  exports: [JoiningChecklistService],
})
export class JoiningModule {}
