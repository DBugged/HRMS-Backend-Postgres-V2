import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class CompleteOffboardingDto {
  // Required only when the employee being offboarded is still another
  // active employee's reportingManagerId — see OffboardingService.complete()
  // and reassignDirectReportsBeforeDeactivation().
  @ApiPropertyOptional({
    description:
      "Required when this employee is still another employee's reportingManagerId — the id of the replacement manager to reassign those direct reports to.",
  })
  @IsOptional()
  @IsUUID()
  reassignManagerId?: string;
}
