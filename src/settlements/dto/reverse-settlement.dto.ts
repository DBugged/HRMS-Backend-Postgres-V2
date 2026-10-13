import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReverseSettlementDto {
  @ApiProperty({
    description: 'Why the processed settlement is being reopened.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
