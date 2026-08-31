import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { loggerModuleOptions } from './common/logger.config';
import { redisEnabled } from './common/redis.config';
import { RedisThrottlerStorage } from './common/redis-throttler-storage';
import { RedisThrottlerStorageModule } from './common/redis-throttler-storage.module';
import { RedisCacheModule } from './common/redis-cache.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { DepartmentsModule } from './departments/departments.module';
import { EmployeesModule } from './employees/employees.module';
import { HolidaysModule } from './holidays/holidays.module';
import { WorkLocationsModule } from './work-locations/work-locations.module';
import { LeaveBalancesModule } from './leave-balances/leave-balances.module';
import { LeaveTypesModule } from './leave-types/leave-types.module';
import { CompOffsModule } from './comp-offs/comp-offs.module';
import { LeavesModule } from './leaves/leaves.module';
import { SalaryComponentsModule } from './salary-components/salary-components.module';
import { PayrollSettingsModule } from './payroll-settings/payroll-settings.module';
import { EmployeeSalaryComponentsModule } from './employee-salary-components/employee-salary-components.module';
import { PayrollTemplatesModule } from './payroll-templates/payroll-templates.module';
import { StatutoryConfigModule } from './statutory-config/statutory-config.module';
import { TaxSlabsModule } from './tax-slabs/tax-slabs.module';
import { TaxDeclarationsModule } from './tax-declarations/tax-declarations.module';
import { AttendanceModule } from './attendance/attendance.module';
import { OvertimeModule } from './overtime/overtime.module';
import { PerformanceRatingsModule } from './performance-ratings/performance-ratings.module';
import { LeaveEncashmentsModule } from './leave-encashments/leave-encashments.module';
import { PayrollModule } from './payroll/payroll.module';
import { ReimbursementsModule } from './reimbursements/reimbursements.module';
import { LoansModule } from './loans/loans.module';
import { SettlementsModule } from './settlements/settlements.module';
import { OffboardingModule } from './offboarding/offboarding.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReportsModule } from './reports/reports.module';
import { FilesModule } from './files/files.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { EmployeeTimelineModule } from './employee-timeline/employee-timeline.module';
import { ApprovalDelegationModule } from './approval-delegation/approval-delegation.module';
import { DocumentsModule } from './documents/documents.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HrEventsModule } from './hr-events/hr-events.module';
import { EmailTemplatesModule } from './email-templates/email-templates.module';
import { OrgListItemsModule } from './org-list-items/org-list-items.module';
import { WorkSchedulesModule } from './work-schedules/work-schedules.module';
import { LettersModule } from './letters/letters.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

@Module({
  imports: [
    // Structured (pino) logging app-wide — see logger.config.ts for why
    // this needs zero changes to the existing new Logger(X.name) call
    // sites scattered across the codebase.
    LoggerModule.forRoot(loggerModuleOptions()),
    // Global default: 100 req / 60s per IP. Auth routes override this
    // much tighter via @Throttle() on the individual routes (see
    // auth.controller.ts) — this is just the floor for everything else.
    // Storage is Redis-backed (shared across instances) when REDIS_URL is
    // set, same opt-in-driver convention as everywhere else — unset falls
    // back to @nestjs/throttler's own in-memory storage, unchanged.
    // forRootAsync + inject (not a manually-`new`'d instance) so
    // RedisThrottlerStorage is a real Nest-managed provider and its
    // onModuleDestroy actually runs on app shutdown — see that class's
    // own comment for why a manually-constructed one leaked connections.
    RedisThrottlerStorageModule,
    ThrottlerModule.forRootAsync({
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: redisEnabled() ? storage : undefined,
      }),
    }),
    // Enables @Cron() handlers app-wide — currently only HrEventsModule's
    // daily birthday/work-anniversary email job.
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisCacheModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    DepartmentsModule,
    EmployeesModule,
    HolidaysModule,
    WorkLocationsModule,
    LeaveBalancesModule,
    LeaveTypesModule,
    CompOffsModule,
    LeavesModule,
    SalaryComponentsModule,
    PayrollSettingsModule,
    EmployeeSalaryComponentsModule,
    PayrollTemplatesModule,
    StatutoryConfigModule,
    TaxSlabsModule,
    TaxDeclarationsModule,
    AttendanceModule,
    OvertimeModule,
    PerformanceRatingsModule,
    LeaveEncashmentsModule,
    PayrollModule,
    ReimbursementsModule,
    LoansModule,
    SettlementsModule,
    OffboardingModule,
    DashboardModule,
    ReportsModule,
    FilesModule,
    AuditLogModule,
    EmployeeTimelineModule,
    ApprovalDelegationModule,
    DocumentsModule,
    NotificationsModule,
    HrEventsModule,
    EmailTemplatesModule,
    OrgListItemsModule,
    WorkSchedulesModule,
    LettersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Every route requires a valid access token by default; @Public()
    // (register/login/refresh/logout) is the explicit opt-out. Keeps
    // "forgot to protect a route" from being the default failure mode,
    // the opposite of the old backend where each route file had to
    // remember to add `protect` itself.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Runs after JwtAuthGuard in the guard chain (registration order),
    // so an already-401'd request doesn't also consume a rate-limit slot.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Every error response (HttpException or not) comes out in one
    // consistent {statusCode, message, error, path, timestamp} shape —
    // see the filter for why message/error are preserved as Nest
    // produces them rather than reshaped.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
