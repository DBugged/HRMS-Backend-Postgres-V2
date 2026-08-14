import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';

export type PayrollTransitionAction = 'verify' | 'approve' | 'lock' | 'pay';

export class BulkTransitionPayrollDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  ids!: string[];

  @ApiProperty({ enum: ['verify', 'approve', 'lock', 'pay'] })
  @IsIn(['verify', 'approve', 'lock', 'pay'])
  action!: PayrollTransitionAction;
}
