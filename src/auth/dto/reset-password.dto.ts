import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  token!: string;

  @ApiProperty({ minLength: 8 })
  @MinLength(8)
  password!: string;
}
