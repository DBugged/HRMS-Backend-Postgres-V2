import { Module } from '@nestjs/common';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [
    NotificationsModule,
    AuditLogModule,
    EmployeeTimelineModule,
    EmailTemplatesModule,
  ],
  controllers: [LoansController],
  providers: [LoansService],
  // Payroll's afterLock() reuses recordRepayment() to deduct each active
  // loan's EMI from the run rather than duplicating the balance-math/
  // auto-close logic.
  exports: [LoansService],
})
export class LoansModule {}
