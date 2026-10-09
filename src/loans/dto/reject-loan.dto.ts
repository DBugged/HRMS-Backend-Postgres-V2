import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectLoanDto {
  @ApiProperty({
    description: 'Why the request is rejected (shown to the employee)',
  })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
