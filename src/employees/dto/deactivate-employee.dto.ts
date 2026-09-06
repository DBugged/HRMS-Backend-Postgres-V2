import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class DeactivateEmployeeDto {
  // Required only when this employee is still another active employee's
  // reportingManagerId — see EmployeesService.deactivate() and
  // reassignDirectReportsBeforeDeactivation().
  @ApiPropertyOptional({
    description:
      "Required when this employee is still another employee's reportingManagerId — the id of the replacement manager to reassign those direct reports to.",
  })
  @IsOptional()
  @IsUUID()
  reassignManagerId?: string;
}
