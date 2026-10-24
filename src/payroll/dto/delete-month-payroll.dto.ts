import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/** Body of POST /payroll/delete-month - which month's not-yet-locked regular runs to delete. */
export class DeleteMonthPayrollDto {
  @ApiProperty({ minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty()
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}
