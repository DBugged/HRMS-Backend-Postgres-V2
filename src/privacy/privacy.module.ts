import { Module } from '@nestjs/common';
import { PrivacyController } from './privacy.controller';
import { PrivacyMeController } from './privacy-me.controller';
import { PrivacyService } from './privacy.service';
import { PrivacyRequestsService } from './privacy-requests.service';
import { PrivacyMeService } from './privacy-me.service';
import { PrivacyAuditService } from './privacy-audit.service';

// PrivacyAuditService is exported so other modules (documents, files, exports) can log to the hash-chained privacy
// trail in a follow-up; nothing outside this module calls it yet.
@Module({
  controllers: [PrivacyController, PrivacyMeController],
  providers: [
    PrivacyService,
    PrivacyRequestsService,
    PrivacyMeService,
    PrivacyAuditService,
  ],
  exports: [PrivacyAuditService, PrivacyService],
})
export class PrivacyModule {}
