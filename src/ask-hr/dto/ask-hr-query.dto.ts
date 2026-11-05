import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class AskHrQueryDto {
  @ApiProperty({ description: 'The question, in plain words.' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;
}
