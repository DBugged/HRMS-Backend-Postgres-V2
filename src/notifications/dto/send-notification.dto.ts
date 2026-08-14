import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class SendNotificationDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty()
  @IsString()
  message!: string;

  @ApiProperty({ enum: ['all', 'department', 'specific'] })
  @IsIn(['all', 'department', 'specific'])
  recipientType!: 'all' | 'department' | 'specific';

  @ApiPropertyOptional({
    description: 'Required when recipientType=department',
  })
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Required when recipientType=specific',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  userIds?: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  sendEmailToo?: boolean;
}
