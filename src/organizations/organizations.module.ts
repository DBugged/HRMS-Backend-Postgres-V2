import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationSettingsService } from './organization-settings.service';
import { EmployeeTypesService } from './employee-types.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';

@Module({
  imports: [AuditLogModule, NotificationsModule, EmailTemplatesModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    OrganizationSettingsService,
    EmployeeTypesService,
  ],
})
export class OrganizationsModule {}
