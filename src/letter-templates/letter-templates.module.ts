import { Module } from '@nestjs/common';
import { LetterTemplatesController } from './letter-templates.controller';
import { LetterTemplatesService } from './letter-templates.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutomationTemplateCheckService } from './automation-template-check.service';

@Module({
  imports: [AuditLogModule, NotificationsModule],
  controllers: [LetterTemplatesController],
  providers: [LetterTemplatesService, AutomationTemplateCheckService],
  exports: [LetterTemplatesService],
})
export class LetterTemplatesModule {}
