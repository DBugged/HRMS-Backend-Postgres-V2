import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';
import { UsersModule } from '../users/users.module';
import { EmployeesModule } from '../employees/employees.module';
import { StatutoryConfigModule } from '../statutory-config/statutory-config.module';
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
