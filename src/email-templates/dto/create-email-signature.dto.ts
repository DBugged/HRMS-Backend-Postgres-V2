import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateEmailSignatureDto {
  @ApiProperty({ example: 'HR Team' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ example: '<p>Regards,<br/>{{companyName}} HR Team</p>' })
  @IsString()
  html!: string;
}
