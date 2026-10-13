import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class CloseReceivableDto {
  @ApiProperty({
    enum: ['RECOVERED', 'WAIVED'],
    description:
      'RECOVERED: the employee paid it (outside payroll). WAIVED: the company gives it up (Admin only).',
  })
  @IsIn(['RECOVERED', 'WAIVED'])
  outcome!: 'RECOVERED' | 'WAIVED';

  @ApiProperty({
    description: 'How and when it was received, or why it is waived.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  note!: string;
}
