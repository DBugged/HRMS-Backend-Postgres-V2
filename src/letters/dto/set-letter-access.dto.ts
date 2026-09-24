import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetLetterAccessDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}
