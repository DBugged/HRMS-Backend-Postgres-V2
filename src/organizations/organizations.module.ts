import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationSettingsService } from './organization-settings.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, OrganizationSettingsService],
})
export class OrganizationsModule {}
