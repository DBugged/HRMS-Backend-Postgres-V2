import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Cancelling an exit: HR says why, and it is kept with the case.
export class CancelOffboardingDto {
  @ApiProperty({ description: 'Why the exit is being cancelled' })
  @IsString()
  @IsNotEmpty({ message: 'Add a reason for cancelling the exit.' })
  @MaxLength(500)
  reason!: string;
}
