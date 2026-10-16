import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RejectLoanDto {
  @ApiProperty({
    description:
      'Why the request is rejected (shown to the employee) - at least 10 characters, same as the app asks for.',
    minLength: 10,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Reason is required.' })
  @MinLength(10, {
    message:
      'Enter the reason for rejecting (at least 10 characters) - it is shared with the employee.',
  })
  reason!: string;
}
