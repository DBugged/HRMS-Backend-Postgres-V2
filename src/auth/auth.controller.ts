import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AuthResponseDto, RegisterResponseDto } from './dto/auth-response.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_DAYS,
} from './auth.constants';

// Overridable per-environment — the e2e suite logs in far more than 5
// times/minute against a single in-memory app instance as normal test
// behavior, not abuse. Production stays at the tight default.
const AUTH_THROTTLE_LIMIT = Number(process.env.AUTH_THROTTLE_LIMIT ?? 5);

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // 5/min per IP on every brute-force-able auth route — tighter than the
  // app-wide default (100/min, see app.module.ts), since these are the
  // routes that matter for credential stuffing / account enumeration.
  @Public()
  @Throttle({ default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60_000 } })
  @Post('register')
  @ApiOkResponse({ type: RegisterResponseDto })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60_000 } })
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60_000 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60_000 } })
  @Post('login')
  @ApiOkResponse({ type: AuthResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setRefreshCookie(res, result.refreshToken);
    return result;
  }

  // Public because the whole point is to accept an *expired-access-token*
  // caller — the refresh token (cookie or body) is the credential here, not
  // the access token this route would otherwise require.
  @Public()
  @Post('refresh')
  @ApiOkResponse({ type: AuthResponseDto })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Cookie takes precedence when both are present — browsers send it
    // automatically; mobile has no cookie jar and always supplies the body
    // field instead. See auth-response.dto.ts for the delivery contract.
    const rawToken = getRefreshCookie(req) || dto.refreshToken;
    if (!rawToken)
      throw new UnauthorizedException('No refresh token provided.');

    const tokens = await this.authService.refresh(rawToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setRefreshCookie(res, tokens.refreshToken);
    return tokens;
  }

  @Public()
  @Post('logout')
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = getRefreshCookie(req) || dto.refreshToken;
    if (rawToken) await this.authService.logout(rawToken);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return { success: true };
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  me(@CurrentUser() user: { id: string; organizationId: string }) {
    return this.authService.me(user.id, user.organizationId);
  }

  @Post('change-password')
  @ApiBearerAuth('access-token')
  changePassword(
    @CurrentUser() user: { id: string; organizationId: string },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.id, user.organizationId, dto);
  }
}

// cookie-parser doesn't ship a typed Request augmentation, so `req.cookies`
// is `any` by default — this narrows it to just the one field this app
// actually reads, instead of trusting `any` at every call site.
function getRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE_NAME];
}

function setRefreshCookie(res: Response, rawToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite:
      (process.env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none') || 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}
