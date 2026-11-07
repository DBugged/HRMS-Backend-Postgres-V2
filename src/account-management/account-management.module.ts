import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { AccountService } from './account.service';
import { AccountExportService } from './account-export.service';
import { AccountSupportService } from './account-support.service';
import { AccountBillingController, AccountExportController, AccountPlanController, AccountSupportController, AccountUsageController } from './account.controllers';

@Module({
  imports: [AuditLogModule, ModuleAccessModule],
  controllers: [AccountBillingController, AccountPlanController, AccountUsageController, AccountExportController, AccountSupportController],
  providers: [AccountService, AccountExportService, AccountSupportService],
})
export class AccountManagementModule {}
