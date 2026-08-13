import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class AuthUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: Role }) role!: Role;
  @ApiProperty() organizationId!: string;
  @ApiProperty() mustChangePassword!: boolean;
}

// Documents the dual-delivery contract: web clients rely on the httpOnly
// refresh_token cookie and can ignore `refreshToken` here; mobile clients
// have no cookie jar and persist both fields directly into secure storage.
export class AuthResponseDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({
    example: 900,
    description: 'Access token lifetime in seconds',
  })
  expiresIn!: number;
  @ApiProperty({ type: AuthUserDto }) user!: AuthUserDto;
}

export class RegisterResponseDto {
  @ApiProperty() organizationId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() message!: string;
}
