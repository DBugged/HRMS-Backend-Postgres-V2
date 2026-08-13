import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { DepartmentsModule } from './departments/departments.module';
import { EmployeesModule } from './employees/employees.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    DepartmentsModule,
    EmployeesModule,
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
  ],
})
export class AppModule {}
