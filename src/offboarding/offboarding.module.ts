import { Module } from '@nestjs/common';
import { OffboardingController } from './offboarding.controller';
import { OffboardingService } from './offboarding.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { LettersModule } from '../letters/letters.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { LeavesModule } from '../leaves/leaves.module';
import { LoansModule } from '../loans/loans.module';
import { PayrollModule } from '../payroll/payroll.module';
import { OffboardingAutomationService } from './offboarding-automation.service';
import { ExitClosureService } from './exit-closure.service';

@Module({
  imports: [
    AuditLogModule,
    EmployeeTimelineModule,
    NotificationsModule,
    EmailTemplatesModule,
    LettersModule,
    SettlementsModule,
    LeavesModule,
    LoansModule,
    PayrollModule,
  ],
  controllers: [OffboardingController],
  providers: [OffboardingService, OffboardingAutomationService, ExitClosureService],
  // Exported so ResignationsService can auto-initiate the exit when a resignation is approved.
  exports: [OffboardingService],
})
export class OffboardingModule {}
