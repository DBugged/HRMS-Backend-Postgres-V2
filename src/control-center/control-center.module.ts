import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsModule } from '../notifications/notifications.module';
import { CcAuthController } from './cc-auth.controller';
import { CcAuthGuard } from './cc-auth.guard';
import { CcAuthService } from './cc-auth.service';

// The Control Panel's API inside the HRMS backend: Super Admin sign-in now; customers, plans and billing follow.
// JwtModule is registered without a secret on purpose - the Control Center signs with CC_JWT_SECRET, passed per call.
@Module({
  imports: [JwtModule.register({}), NotificationsModule],
  controllers: [CcAuthController],
  providers: [CcAuthService, CcAuthGuard],
  exports: [CcAuthService, CcAuthGuard],
})
export class ControlCenterModule {}
