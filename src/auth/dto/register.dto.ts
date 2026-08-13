import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsNotEmpty()
  organizationName!: string;

  @ApiProperty({ example: 'Jane Founder' })
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'founder@acme.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!', minLength: 8 })
  @MinLength(8)
  password!: string;
}
