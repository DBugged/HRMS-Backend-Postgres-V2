import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountExportScheduleService } from './account-export-schedule.service';
import { AccountNotifier } from './account-notifier.service';
import { AccountService } from './account.service';
import { AccountExportService } from './account-export.service';
import { AccountSupportService } from './account-support.service';
import { AccountBillingController, AccountActivityController, AccountExportConfirmController, AccountExportController, AccountPlanController, AccountSupportController, AccountUsageController } from './account.controllers';

@Module({
  imports: [AuditLogModule, ModuleAccessModule, NotificationsModule],
  controllers: [AccountExportConfirmController, AccountActivityController, AccountBillingController, AccountPlanController, AccountUsageController, AccountExportController, AccountSupportController],
  providers: [AccountService, AccountExportService, AccountSupportService, AccountNotifier, AccountExportScheduleService],
  exports: [AccountNotifier],
})
export class AccountManagementModule {}
