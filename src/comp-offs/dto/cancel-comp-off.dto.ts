import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelCompOffDto {
  @ApiProperty({
    maxLength: 1000,
    description:
      'Why the approved comp-off is withdrawn; shown to the employee.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
