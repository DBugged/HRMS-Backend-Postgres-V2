import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RequestWithdrawalDto {
  @ApiProperty({
    maxLength: 500,
    description: 'Why the employee wants to withdraw an approved resignation.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
