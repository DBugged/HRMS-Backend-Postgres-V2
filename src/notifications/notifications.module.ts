import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email.service';
import { PushService } from './push.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, EmailService, PushService],
  exports: [NotificationsService, EmailService, PushService],
})
export class NotificationsModule {}
