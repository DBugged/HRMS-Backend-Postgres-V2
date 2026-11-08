import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Cancelling a planned field visit: the reason is kept as the visit's outcome.
export class CancelVisitDto {
  @ApiProperty({ description: 'Why the visit is being cancelled' })
  @IsString()
  @IsNotEmpty({ message: 'Add a reason for cancelling the visit.' })
  @MaxLength(500)
  reason!: string;
}
