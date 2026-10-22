// Purpose: HTTP for Control Panel sign-in, at /api/v1/auth/* (the base path the panel's own client uses).
// Important: @Public() only switches off the HRMS global token guard - the protected routes (me, logout-all) use CcAuthGuard.
//   The refresh token lives in an httpOnly cookie (cc_rt) limited to this path, never in the response body.
import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { cookieSecure } from '../common/production-config';
import { CcAuthService } from './cc-auth.service';
import { CcAuthGuard, CurrentSuperAdmin } from './cc-auth.guard';
import { REFRESH_TOKEN_DAYS } from './cc-auth-rules';
import { CcForgotPasswordDto, CcLoginDto, CcResetPasswordDto } from './dto/cc-auth.dto';
import type { SuperAdmin } from '@prisma/client';

const COOKIE = 'cc_rt';
const COOKIE_PATH = '/api/v1/auth';

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
const readCookie = (req: Request): string | undefined => (req.cookies as Record<string, string> | undefined)?.[COOKIE];

function setCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: (process.env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none') || 'lax',
    path: COOKIE_PATH,
    maxAge: REFRESH_TOKEN_DAYS * 86400000,
  });
}
const clearCookie = (res: Response) => res.clearCookie(COOKIE, { path: COOKIE_PATH });

@ApiTags('control-center')
@Public()
@Controller('api/v1/auth')
export class CcAuthController {
  constructor(private readonly auth: CcAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: CcLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...body } = await this.auth.login(dto.email, dto.password, meta(req));
    setCookie(res, refreshToken);
    return body;
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const { refreshToken, ...body } = await this.auth.refresh(readCookie(req), meta(req));
      setCookie(res, refreshToken);
      return body;
    } catch (err) {
      clearCookie(res);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readCookie(req));
    clearCookie(res);
  }

  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(CcAuthGuard)
  async logoutAll(@CurrentSuperAdmin() admin: SuperAdmin, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(admin.id);
    clearCookie(res);
  }

  @Post('forgot-password')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forgot(@Body() dto: CcForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reset(@Body() dto: CcResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.password);
  }

  @Get('me')
  @UseGuards(CcAuthGuard)
  me(@CurrentSuperAdmin() admin: SuperAdmin) {
    return this.auth.toMe(admin);
  }
}
