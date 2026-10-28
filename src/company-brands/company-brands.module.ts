import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyBrandsController } from './company-brands.controller';
import { CompanyBrandsService } from './company-brands.service';
import { BrandingLookupService } from './branding-lookup.service';

@Module({
  imports: [AuditLogModule],
  controllers: [CompanyBrandsController],
  providers: [CompanyBrandsService, BrandingLookupService],
  // Exported so payslips, letters and emails can ask which name and logo apply to a person.
  exports: [BrandingLookupService],
})
export class CompanyBrandsModule {}
