import { Module } from '@nestjs/common';
import { HrEventsService } from './hr-events.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [HrEventsService],
})
export class HrEventsModule {}
