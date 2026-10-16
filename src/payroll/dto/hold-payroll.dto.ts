import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class HoldPayrollDto {
  // Withholding someone's pay needs a recorded reason - it is the first thing asked when they query it.
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MinLength(3, { message: 'Give a reason for holding this salary.' })
  @MaxLength(300)
  reason!: string;
}
