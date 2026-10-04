import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const TOKEN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/;

export class RegisterPushDeviceDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })
  @Matches(TOKEN, { message: 'token must be an Expo push token.' })
  token!: string;

  @ApiProperty({ enum: ['ios', 'android'] })
  @IsIn(['ios', 'android'])
  platform!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceName?: string;
}

export class UnregisterPushDeviceDto {
  @ApiProperty()
  @Matches(TOKEN, { message: 'token must be an Expo push token.' })
  token!: string;
}
