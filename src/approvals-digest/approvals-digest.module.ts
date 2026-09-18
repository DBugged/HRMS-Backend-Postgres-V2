import { Module } from '@nestjs/common';
import { ApprovalsDigestService } from './approvals-digest.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [NotificationsModule, EmailTemplatesModule],
  providers: [ApprovalsDigestService],
  exports: [ApprovalsDigestService],
})
export class ApprovalsDigestModule {}
