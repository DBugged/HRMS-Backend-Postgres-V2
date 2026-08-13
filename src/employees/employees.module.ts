import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeeIdService } from './employee-id.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeIdService],
  // EmployeeIdService is exported specifically so AuthModule can reuse it
  // for founder-account creation (the founder is Employee #1 of their own
  // org) instead of duplicating the row-locked counter logic.
  exports: [EmployeeIdService],
})
export class EmployeesModule {}
