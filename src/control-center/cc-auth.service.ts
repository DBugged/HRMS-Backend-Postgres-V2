// Purpose: Sign-in for the Control Panel's Super Admins: login, refresh, logout, forgot/reset password and "who am I".
// Responsibilities: checks the password (lock-out after repeated failures), issues a short-lived access token signed with
//   its OWN secret (CC_JWT_SECRET, never the HRMS one) and a rotating refresh token kept only as a hash, and resolves an
//   access token back to an active Super Admin for CcAuthGuard.
// Important: Super Admins belong to no company and are a different kind of account from HRMS users: a token from one side
//   is rejected by the other (different secret and a `typ` claim). A refresh token that is used twice means it was copied,
//   so every session of that admin is ended. Wrong email and wrong password give the same answer.
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { SuperAdmin } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { EmailService } from '../notifications/email.service';
import { permissionsFor, type SuperAdminRoleName } from './cc-permissions';
import {
  ACCESS_TOKEN_SECONDS,
  REFRESH_TOKEN_DAYS,
  RESET_TOKEN_MINUTES,
  afterFailedAttempt,
  hashToken,
  lockMinutesLeft,
  newToken,
  normalizeEmail,
  passwordProblem,
} from './cc-auth-rules';

export interface CcMe {
  id: string;
  email: string;
  name: string;
  role: SuperAdminRoleName;
  permissions: string[];
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

const ACCESS_TYP = 'cc-access';
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password. Made once, on first use.
let dummyHash: string | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync('not-a-real-password', 12));

@Injectable()
export class CcAuthService {
  private readonly logger = new Logger(CcAuthService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
  ) {}

  // The signing secret. Without a strong one the Control Panel sign-in is simply switched off, so a deployment that does
  // not use it is unaffected.
  private secret(): string {
    const s = process.env.CC_JWT_SECRET;
    if (!s || s.length < 32) {
      throw new ServiceUnavailableException('Control Center sign-in is not configured on this server.');
    }
    return s;
  }

  toMe(a: Pick<SuperAdmin, 'id' | 'email' | 'name' | 'role' | 'mfaEnabled' | 'lastLoginAt'>): CcMe {
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      role: a.role,
      permissions: permissionsFor(a.role),
      mfaEnabled: a.mfaEnabled,
      lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
    };
  }

  private signAccess(admin: SuperAdmin): Promise<string> {
    return this.jwt.signAsync({ sub: admin.id, role: admin.role, typ: ACCESS_TYP }, { secret: this.secret(), expiresIn: ACCESS_TOKEN_SECONDS });
  }

  private async startSession(adminId: string, meta: RequestMeta): Promise<string> {
    const { token, hash } = newToken();
    await this.prisma.superAdminSession.create({
      data: {
        superAdminId: adminId,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000),
        userAgent: meta.userAgent?.slice(0, 300),
        ip: meta.ip,
      },
    });
    return token;
  }

  async login(emailRaw: string, password: string, meta: RequestMeta) {
    this.secret();
    const now = new Date();
    const admin = await this.prisma.superAdmin.findUnique({ where: { email: normalizeEmail(emailRaw) } });
    const usable = !!admin && admin.status === 'ACTIVE' && !!admin.passwordHash;

    if (usable) {
      const left = lockMinutesLeft(admin.lockedUntil, now);
      if (left > 0) {
        throw new HttpException(`Too many wrong passwords. Try again in ${left} minute${left === 1 ? '' : 's'}.`, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    const ok = await bcrypt.compare(password, usable ? (admin.passwordHash as string) : getDummyHash());
    if (!usable || !ok) {
      if (usable) {
        await this.prisma.superAdmin.update({ where: { id: admin.id }, data: afterFailedAttempt(admin.failedLoginAttempts, now) });
      }
      throw new UnauthorizedException('Invalid email or password.');
    }

    const updated = await this.prisma.superAdmin.update({
      where: { id: admin.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
    });
    const refreshToken = await this.startSession(admin.id, meta);
    this.logger.log(`Control Center sign-in: ${admin.id} (${admin.role})`);
    return {
      accessToken: await this.signAccess(updated),
      expiresIn: ACCESS_TOKEN_SECONDS,
      user: this.toMe({ ...updated, lastLoginAt: now }),
      refreshToken,
    };
  }

  // Swaps a refresh token for a new access token and a new refresh token. The old one stops working at once.
  async refresh(rawToken: string | undefined, meta: RequestMeta) {
    this.secret();
    if (!rawToken) throw new UnauthorizedException('Not signed in.');
    const session = await this.prisma.superAdminSession.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { superAdmin: true },
    });
    if (!session) throw new UnauthorizedException('Session expired. Sign in again.');
    if (session.revokedAt) {
      // A token that was already used is being used again: treat it as stolen and end every session of that admin.
      await this.prisma.superAdminSession.updateMany({
        where: { superAdminId: session.superAdminId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Control Center refresh token reused: all sessions of ${session.superAdminId} ended`);
      throw new UnauthorizedException('Session expired. Sign in again.');
    }
    if (session.expiresAt <= new Date() || session.superAdmin.status !== 'ACTIVE') {
      throw new UnauthorizedException('Session expired. Sign in again.');
    }
    await this.prisma.superAdminSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    const refreshToken = await this.startSession(session.superAdminId, meta);
    return { accessToken: await this.signAccess(session.superAdmin), expiresIn: ACCESS_TOKEN_SECONDS, refreshToken };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.prisma.superAdminSession.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(adminId: string): Promise<void> {
    await this.prisma.superAdminSession.updateMany({ where: { superAdminId: adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  // Always answers the same, whether or not the email belongs to an admin.
  async forgotPassword(emailRaw: string): Promise<void> {
    const admin = await this.prisma.superAdmin.findUnique({ where: { email: normalizeEmail(emailRaw) } });
    if (!admin || admin.status === 'DEACTIVATED') return;
    const { token, hash } = newToken(32);
    await this.prisma.superAdmin.update({
      where: { id: admin.id },
      data: { passwordResetTokenHash: hash, passwordResetExpires: new Date(Date.now() + RESET_TOKEN_MINUTES * 60000) },
    });
    const base = (process.env.CC_FRONTEND_URL || 'http://localhost:3101').replace(/\/$/, '');
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
    await this.email.send({
      to: admin.email,
      subject: 'Reset your Control Center password',
      html: `<p>Hi ${escapeHtml(admin.name)},</p><p>Use this link to choose a new password. It works for ${RESET_TOKEN_MINUTES} minutes.</p><p><a href="${link}">Reset password</a></p><p>If you did not ask for this, you can ignore this email.</p>`,
    }).catch((err) => this.logger.warn(`Reset email to ${admin.id} failed: ${(err as Error).message}`));
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const problem = passwordProblem(password);
    if (problem) throw new BadRequestException(problem);
    const admin = await this.prisma.superAdmin.findFirst({
      where: { passwordResetTokenHash: hashToken(token), passwordResetExpires: { gt: new Date() } },
    });
    if (!admin || admin.status === 'DEACTIVATED') throw new BadRequestException('This reset link is invalid or has expired. Request a new one.');
    await this.prisma.superAdmin.update({
      where: { id: admin.id },
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        status: 'ACTIVE',
        passwordResetTokenHash: null,
        passwordResetExpires: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await this.logoutAll(admin.id);
  }

  // Access token -> an active Super Admin (or 401). Used by CcAuthGuard on every protected Control Center route.
  async verifyAccess(token: string): Promise<SuperAdmin> {
    let payload: { sub?: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.secret() });
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new UnauthorizedException();
    }
    if (payload.typ !== ACCESS_TYP || !payload.sub) throw new UnauthorizedException();
    const admin = await this.prisma.superAdmin.findUnique({ where: { id: payload.sub } });
    if (!admin || admin.status !== 'ACTIVE') throw new UnauthorizedException();
    return admin;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
