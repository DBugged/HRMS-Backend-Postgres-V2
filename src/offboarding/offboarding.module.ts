import { Module } from '@nestjs/common';
import { OffboardingController } from './offboarding.controller';
import { OffboardingService } from './offboarding.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { LettersModule } from '../letters/letters.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { OffboardingAutomationService } from './offboarding-automation.service';

@Module({
  imports: [
    AuditLogModule,
    EmployeeTimelineModule,
    NotificationsModule,
    EmailTemplatesModule,
    LettersModule,
    SettlementsModule,
  ],
  controllers: [OffboardingController],
  providers: [OffboardingService, OffboardingAutomationService],
  // Exported so ResignationsService can auto-initiate the exit when a resignation is approved.
  exports: [OffboardingService],
})
export class OffboardingModule {}
