import { Module } from '@nestjs/common';
import { OrgListItemsController } from './org-list-items.controller';
import { OrgListItemsService } from './org-list-items.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [OrgListItemsController],
  providers: [OrgListItemsService],
  exports: [OrgListItemsService],
})
export class OrgListItemsModule {}
