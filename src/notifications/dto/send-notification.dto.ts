import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
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

  // The send form always round-trips this field on the request body (it
  // stays '' whenever recipientType isn't 'department'), so '' has to
  // stay valid — @IsOptional alone only skips validation for undefined.
  @ApiPropertyOptional({
    description: 'Required when recipientType=department',
  })
  @IsOptional()
  @ValidateIf((o) => o.department !== '')
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
