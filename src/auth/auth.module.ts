import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';
import { UsersModule } from '../users/users.module';
import { EmployeesModule } from '../employees/employees.module';
import { StatutoryConfigModule } from '../statutory-config/statutory-config.module';
import { LeaveTypesModule } from '../leave-types/leave-types.module';
import { SalaryComponentsModule } from '../salary-components/salary-components.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    UsersModule,
    // For EmployeeIdService only (the founder is Employee #1 of their own
    // org) — see AuthService's constructor comment.
    EmployeesModule,
    // For StatutoryConfigService.seedDefaults — every new org gets all 9
    // statutory modules pre-seeded at registration, same integration
    // point as EmployeeIdService above.
    StatutoryConfigModule,
    // For LeaveTypesService.seedDefaults — every new org gets the standard
    // leave-type set (Casual, Sick, Earned, Maternity, etc.) at
    // registration, same integration point as StatutoryConfigModule above.
    LeaveTypesModule,
    // For SalaryComponentsService.seedDefaults — every new org gets the
    // standard salary-component catalog at registration, same
    // integration point as LeaveTypesModule above.
    SalaryComponentsModule,
    // For HolidaysService.seedDefaults — every new org gets the current
    // year's 3 fixed National Holidays at registration, same integration
    // point as SalaryComponentsModule above.
    HolidaysModule,
    // For EmailTemplatesService.seedDefaults — every new org gets the
    // standard occasion-based email templates (Birthday, Work Anniversary)
    // at registration, same integration point as HolidaysModule above.
    EmailTemplatesModule,
    AuditLogModule,
    NotificationsModule,
    // Signing options are passed explicitly per-call in AuthService
    // (different secret/TTL for access vs refresh isn't expressible via a
    // single module-level JwtModule config), so this registration just
    // makes JwtService available for injection.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAccessStrategy],
  exports: [AuthService],
})
export class AuthModule {}
