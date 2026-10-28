import { Module } from '@nestjs/common';
import { LettersController } from './letters.controller';
import { LettersService } from './letters.service';
import { LetterPdfService } from './letter-pdf.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { LetterTemplatesModule } from '../letter-templates/letter-templates.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

import { CompanyBrandsModule } from '../company-brands/company-brands.module';

@Module({
  imports: [
    AuditLogModule,
    LetterTemplatesModule,
    EmployeeTimelineModule,
    NotificationsModule,
    EmailTemplatesModule,
    CompanyBrandsModule,
  ],
  controllers: [LettersController],
  providers: [LettersService, LetterPdfService],
  // Exported so completing an exit can email the relieving / experience letters.
  exports: [LettersService],
})
export class LettersModule {}
