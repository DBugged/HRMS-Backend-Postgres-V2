import { Module } from '@nestjs/common';
import { CustomFieldsController, EmployeeCustomFieldsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [CustomFieldsController, EmployeeCustomFieldsController],
  providers: [CustomFieldsService],
})
export class CustomFieldsModule {}
