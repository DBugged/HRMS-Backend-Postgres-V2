import { Module } from '@nestjs/common';
import { ResignationsController } from './resignations.controller';
import { ResignationsService } from './resignations.service';
import { OffboardingModule } from '../offboarding/offboarding.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

import { LettersModule } from '../letters/letters.module';

@Module({
  imports: [
    OffboardingModule,
    LettersModule,
    AuditLogModule,
    EmployeeTimelineModule,
    NotificationsModule,
    EmailTemplatesModule,
  ],
  controllers: [ResignationsController],
  providers: [ResignationsService],
})
export class ResignationsModule {}
