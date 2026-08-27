import { Module } from '@nestjs/common';
import { HrEventsService } from './hr-events.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [NotificationsModule, EmailTemplatesModule],
  providers: [HrEventsService],
  exports: [HrEventsService],
})
export class HrEventsModule {}
