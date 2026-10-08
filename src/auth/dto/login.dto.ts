import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { NormalizeEmail } from '../../common/normalize-input';

const EXPO_PUSH_TOKEN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/;

export class LoginDto {
  @ApiProperty({ example: 'founder@acme.test' })
  @NormalizeEmail()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsNotEmpty()
  password!: string;

  // Mobile sends its Expo push token under this name at login so the app
  // doesn't need a second round-trip to /notifications/devices right after
  // signing in. Same token format PushService already accepts there.
  @ApiPropertyOptional({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })
  @IsOptional()
  @Matches(EXPO_PUSH_TOKEN, { message: 'fcmToken must be an Expo push token.' })
  fcmToken?: string;

  @ApiPropertyOptional({ enum: ['ios', 'android'] })
  @IsOptional()
  @IsIn(['ios', 'android'])
  os?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  buildNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  deviceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceModel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  osVersion?: string;
}
