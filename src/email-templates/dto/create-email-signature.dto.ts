import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';

export class CreateEmailSignatureDto {
  @ApiProperty({ example: 'HR Team' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '<p>Regards,<br/>{{companyName}} HR Team</p>' })
  @IsString()
  @MaxLength(50000)
  html!: string;
}
