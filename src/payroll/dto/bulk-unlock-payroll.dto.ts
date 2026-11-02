import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class BulkUnlockPayrollDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids!: string[];

  // One reason, kept on every run it unlocks (reopening finalized payroll always needs a recorded reason).
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MinLength(5, {
    message: 'Give a reason of at least 5 characters for unlocking payroll.',
  })
  @MaxLength(500)
  reason!: string;
}
