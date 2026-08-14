import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID, Min } from 'class-validator';

export class RequestLeaveEncashmentDto {
  @ApiProperty()
  @Min(0.5)
  days!: number;

  @ApiProperty({ description: 'LeaveType id' })
  @IsNotEmpty()
  @IsUUID()
  leaveType!: string;
}
