import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class StartEmailDomainVerificationDto {
  @ApiProperty({ example: 'hr@yourcompany.com' })
  @IsNotEmpty()
  @IsEmail()
  email!: string;
}
