import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class UnlockPayrollDto {
  // Reopening finalized payroll changes money that may already have been paid — a recorded reason is mandatory.
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MinLength(5, {
    message: 'Give a reason of at least 5 characters for unlocking payroll.',
  })
  @MaxLength(500)
  reason!: string;
}
