import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CcAuthController } from './cc-auth.controller';
import { CcAuthGuard } from './cc-auth.guard';
import { CcAuthService } from './cc-auth.service';
import { CcCustomersController } from './cc-customers.controller';
import { CcCustomersService } from './cc-customers.service';
import { CcAnnouncementsFeedController } from './cc-announcements-feed.controller';
import { CcAutomationService } from './cc-automation.service';
import { CcInsightsService } from './cc-insights.service';
import { CcReportsController } from './cc-reports.controller';
import { CcReportsService } from './cc-reports.service';
import { CcBillingController } from './cc-billing.controller';
import { CcBillingService } from './cc-billing.service';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CcAuditInterceptor } from './cc-audit.interceptor';
import { CcSupportController } from './cc-support.controller';
import { CcSupportService } from './cc-support.service';
import { CcPlansController } from './cc-plans.controller';
import { CcPlansService } from './cc-plans.service';
import { CcPermissionGuard } from './cc-permission.guard';

// The Control Panel's API inside the HRMS backend: Super Admin sign-in and read-only customers/dashboard now; plans and billing follow.
// JwtModule is registered without a secret on purpose - the Control Center signs with CC_JWT_SECRET, passed per call.
@Module({
  imports: [JwtModule.register({}), NotificationsModule, AuthModule],
  controllers: [CcAuthController, CcCustomersController, CcPlansController, CcBillingController, CcSupportController, CcAnnouncementsFeedController, CcReportsController],
  providers: [CcAuthService, CcAuthGuard, CcCustomersService, CcPlansService, CcBillingService, CcSupportService, CcAutomationService, CcInsightsService, CcReportsService, CcPermissionGuard, { provide: APP_INTERCEPTOR, useClass: CcAuditInterceptor }],
  exports: [CcAuthService, CcAuthGuard],
})
export class ControlCenterModule {}
