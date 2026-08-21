// Purpose: Handles registration (org + founder bootstrap), login, token refresh/rotation, logout, and
// password reset/change.
// Responsibilities: Owns JWT access/refresh token issuance and hashing; delegates default-data seeding on
// registration to StatutoryConfigService, LeaveTypesService, SalaryComponentsService and HolidaysService,
// and employeeId generation to EmployeeIdService, all inside one transaction.
// Important: register() and resetPassword() must run on the tenant-scope-extended client's own
// $transaction (see constructor comment) or the tx writes silently bypass tenant scoping. Refresh tokens
// rotate on every use (revoke-and-reissue) to limit replay of a leaked token. forgotPassword() and
// findRefreshTokenByHash() deliberately return the same response/bypass tenant scoping for tenant-unknown
// lookups by design, not by oversight.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { signFileToken } from '../files/file-token';
import { signPersonalDataFileUrls } from '../employees/personal-data';
import { UsersService } from '../users/users.service';
import { EmployeeIdService } from '../employees/employee-id.service';
import { StatutoryConfigService } from '../statutory-config/statutory-config.service';
import { LeaveTypesService } from '../leave-types/leave-types.service';
import { SalaryComponentsService } from '../salary-components/salary-components.service';
import { HolidaysService } from '../holidays/holidays.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmailService } from '../notifications/email.service';
import { frontendUrl } from '../common/frontend-url';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AuthUserDto } from './dto/auth-response.dto';
import { JwtPayload } from '../common/interfaces/jwt-payload.interface';
import {
  REFRESH_TOKEN_TTL_DAYS,
  ACCESS_TOKEN_TTL_SECONDS,
} from './auth.constants';

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);
// 30 minutes — matches the old system's window exactly.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
// Same generic message regardless of whether the email exists — never
// reveals account existence, ported from the old system's forgotPassword.
const FORGOT_PASSWORD_GENERIC_MESSAGE =
  'If that email exists, a reset link has been sent.';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    // The tenant-scope-extended client only, including for
    // $transaction() — see the identical comment on EmployeesService for
    // why the plain (unextended) client's $transaction must not be used
    // for a transaction that writes a tenant-scoped model.
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly usersService: UsersService,
    private readonly employeeIdService: EmployeeIdService,
    private readonly statutoryConfigService: StatutoryConfigService,
    private readonly leaveTypesService: LeaveTypesService,
    private readonly salaryComponentsService: SalaryComponentsService,
    private readonly holidaysService: HolidaysService,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, SALT_ROUNDS);

    // Prisma's interactive $transaction, analogous to the old system's
    // Sequelize transaction wrapping org+founder creation. Called on the
    // tenant-scope-extended client (see constructor comment) so the
    // tx.user.create() below is actually covered by the guard, not just
    // the tx.organization.create() call (Organization isn't tenant-scoped
    // at all, so that part wouldn't matter either way).
    const { organization, user } = await this.scopedPrisma.$transaction(
      async (tx) => {
        const organization = await tx.organization.create({
          data: { name: dto.organizationName },
        });
        // Every new org gets all 9 statutory modules pre-seeded (most
        // disabled, payroll_calendar/rounding always enabled) so the
        // future payroll engine's period-aware resolution has a row to
        // resolve from day one — same registration-time integration point
        // as the old system's registerOrganization.
        await this.statutoryConfigService.seedDefaults(tx, organization.id);
        // The founder is Employee #1 of their own org — employeeId
        // generation is an Employees-module concern (row-locked counter on
        // Organization, see EmployeeIdService), reused here rather than
        // duplicated, same as the old system's registerOrganization calling
        // the same generateEmployeeId() every other employee creation path uses.
        const employeeId = await this.employeeIdService.generate(
          tx,
          organization.id,
        );
        const user = await tx.user.create({
          data: {
            organizationId: organization.id,
            employeeId,
            email: dto.email,
            password: hashedPassword,
            name: dto.name,
            role: Role.ADMIN,
            isFounder: true,
            mustChangePassword: false,
            employmentStatus: 'CONFIRMED',
            // Email verification (token + send) is deferred to when Resend
            // infra is added in a later phase — documented simplification,
            // not an oversight. The old system defaults this to false and
            // requires a verify-email click; v2 skips that step for now.
            emailVerified: true,
          },
        });
        // Every new org starts with the standard leave-type set (Casual,
        // Sick, Earned, Maternity, etc.) instead of an empty Leave Types
        // page — admin can edit/disable/add to these afterward, same
        // registration-time integration point as the statutory defaults
        // above.
        await this.leaveTypesService.seedDefaults(tx, organization.id, user.id);
        // Every new org also starts with the standard salary-component
        // catalog (Basic, HRA, PF, ESI, PT, employer contributions, etc.)
        // instead of an empty Salary Components page and blank payslips.
        await this.salaryComponentsService.seedDefaults(
          tx,
          organization.id,
          user.id,
        );
        // Every new org also starts with the current year's 3 fixed
        // National Holidays so the Holiday Calendar isn't empty on day one.
        await this.holidaysService.seedDefaults(tx, organization.id);
        return { organization, user };
      },
    );

    return {
      organizationId: organization.id,
      userId: user.id,
      message: 'Account created. You can now log in.',
    };
  }

  async login(
    dto: LoginDto,
    meta: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens & { user: AuthUserDto }> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.usersService.updateLastLogin(user.id, user.organizationId);
    const tokens = await this.issueTokenPair(
      user.id,
      user.organizationId,
      user.role,
      meta,
    );
    await this.auditLogService.log({
      actorId: user.id,
      action: 'LOGIN',
      module: 'AUTH',
      organizationId: user.organizationId,
      ipAddress: meta.ip ?? '',
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  async refresh(
    rawToken: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    const tokenHash = hashToken(rawToken);
    const existing = await this.findRefreshTokenByHash(tokenHash);

    if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }

    const user = await this.usersService.findByIdInOrg(
      existing.userId,
      existing.organizationId,
    );
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }

    // Rotation: revoke the presented token and mint a brand-new one, rather
    // than reusing it — the old system had no refresh tokens at all, so
    // this is new ground, and rotation-on-use is the standard mitigation
    // against a leaked refresh token being replayed indefinitely.
    const tokens = await this.issueTokenPair(
      user.id,
      user.organizationId,
      user.role,
      meta,
    );
    await this.scopedPrisma.refreshToken.updateMany({
      where: { id: existing.id, organizationId: existing.organizationId },
      data: {
        revokedAt: new Date(),
        replacedByTokenHash: hashToken(tokens.refreshToken),
      },
    });

    return tokens;
  }

  async logout(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const existing = await this.findRefreshTokenByHash(tokenHash);
    if (!existing || existing.revokedAt) return; // idempotent — old system's forgot-password has the same "don't reveal state" spirit
    await this.scopedPrisma.refreshToken.updateMany({
      where: { id: existing.id, organizationId: existing.organizationId },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string, organizationId: string) {
    const user = await this.usersService.findByIdInOrg(userId, organizationId);
    if (!user) throw new UnauthorizedException();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash deliberately
    const { password, ...safe } = user;
    // profileImage is a durable relativeKey (never a signed URL — see
    // file-token.ts), so it's signed fresh on every read.
    if (safe.profileImage) {
      safe.profileImage = `/files/${signFileToken(safe.organizationId, safe.profileImage)}`;
    }
    if (safe.personalData && typeof safe.personalData === 'object') {
      safe.personalData = signPersonalDataFileUrls(
        safe.personalData as Record<string, unknown>,
        safe.organizationId,
      ) as unknown as typeof safe.personalData;
    }
    return safe;
  }

  // Never reveals whether the email exists — same response either way.
  // Ported from the old system's forgotPassword exactly (32-byte raw
  // token mailed to the user, SHA-256 hash stored, 30-minute expiry).
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(dto.email);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      await this.scopedPrisma.user.updateMany({
        where: { id: user.id, organizationId: user.organizationId },
        data: {
          resetPasswordToken: hashToken(rawToken),
          resetPasswordExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });

      const resetUrl = `${frontendUrl()}/reset-password/${rawToken}`;
      await this.emailService.send({
        to: user.email,
        subject: "D'Bugged Programmers HRMS - Password Reset",
        html: `<p>Hello ${user.name},</p><p>Click the link below to reset your password. This link expires in 30 minutes.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
      });
    }
    return { message: FORGOT_PASSWORD_GENERIC_MESSAGE };
  }

  // One vague error for both "invalid" and "expired" — deliberately
  // doesn't distinguish, same as the old system. Also revokes every
  // active refresh token for the account (an enhancement beyond the old
  // system, which had no session concept to revoke) so a compromised
  // session doesn't survive a password reset.
  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const tokenHash = hashToken(dto.token);
    const user = await this.usersService.findByResetToken(tokenHash);
    if (
      !user ||
      !user.resetPasswordExpires ||
      user.resetPasswordExpires < new Date()
    ) {
      throw new BadRequestException('Reset link is invalid or has expired.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, SALT_ROUNDS);
    await this.scopedPrisma.$transaction([
      this.scopedPrisma.user.updateMany({
        where: { id: user.id, organizationId: user.organizationId },
        data: {
          password: hashedPassword,
          resetPasswordToken: null,
          resetPasswordExpires: null,
          mustChangePassword: false,
        },
      }),
      this.scopedPrisma.refreshToken.updateMany({
        where: {
          userId: user.id,
          organizationId: user.organizationId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { message: 'Password updated successfully. Please log in.' };
  }

  // Shared by the mandatory first-login flow (mustChangePassword=true) and
  // a routine voluntary password change from the Profile page — same
  // endpoint the old system used for both. Reads mustChangePassword before
  // clearing it so the welcome email below only fires on the actual
  // first-time change, not every subsequent password update.
  async changePassword(
    userId: string,
    organizationId: string,
    dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    const user = await this.usersService.findByIdInOrg(userId, organizationId);
    if (!user) throw new UnauthorizedException();

    const valid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!valid) {
      throw new BadRequestException('Current password is incorrect.');
    }

    const wasFirstTimeChange = user.mustChangePassword;
    const hashedPassword = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    // Revoke every active refresh token on a voluntary password change too,
    // same as resetPassword — otherwise a session hijacked via a leaked
    // refresh token would survive the very password change meant to shut
    // it out, since that token never expires on its own for
    // REFRESH_TOKEN_TTL_DAYS.
    await this.scopedPrisma.$transaction([
      this.scopedPrisma.user.updateMany({
        where: { id: user.id, organizationId: user.organizationId },
        data: { password: hashedPassword, mustChangePassword: false },
      }),
      this.scopedPrisma.refreshToken.updateMany({
        where: {
          userId: user.id,
          organizationId: user.organizationId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
    ]);

    if (wasFirstTimeChange) {
      // Best-effort, fire-and-forget — a send failure must never fail the
      // password change itself, same as the old system.
      this.emailService
        .send({
          to: user.email,
          subject: 'Welcome to your HRMS account',
          html: `<p>Hello ${user.name},</p><p>Your account is now active. From here on, all HRMS communication — leave approvals, payslips, announcements, and more — will be sent to this address (${user.email}).</p>`,
        })
        .catch((err: Error) => {
          this.logger.error(
            `Failed to send welcome email: ${err.message}`,
            err.stack,
          );
        });
    }

    return { message: 'Password changed successfully.' };
  }

  private async issueTokenPair(
    userId: string,
    organizationId: string,
    role: Role,
    meta: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    const payload: JwtPayload = {
      sub: userId,
      organizationId,
      role,
      jti: crypto.randomUUID(),
    };
    // expiresIn takes seconds (a plain number) rather than re-parsing the
    // env string here too — ACCESS_TOKEN_TTL_SECONDS already did that once.
    const accessToken = await this.jwt.signAsync(payload as object, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    const rawRefreshToken = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.scopedPrisma.refreshToken.create({
      data: {
        userId,
        organizationId,
        tokenHash: hashToken(rawRefreshToken),
        expiresAt,
        createdByIp: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Shared by refresh() and logout(). The lookup isn't organizationId-
   * scoped up front — we don't know the org yet from an opaque token —
   * which is the same class of tenant-unknown lookup as an email lookup,
   * so it uses the bypass deliberately; every subsequent operation on the
   * result is then scoped by the row's own organizationId.
   *
   * Prisma's generated findFirst arg type has a `[key: string]: never`
   * excess-property guard, so `__tenantScopeBypass` can't be added via a
   * plain intersection — the through-unknown cast is the deliberate,
   * narrow escape hatch for exactly this one extension-only field.
   */
  private findRefreshTokenByHash(tokenHash: string) {
    type FindFirstArgs = Parameters<
      typeof this.scopedPrisma.refreshToken.findFirst
    >[0];
    const args = {
      where: { tokenHash },
      __tenantScopeBypass: true,
    } as unknown as FindFirstArgs;
    return this.scopedPrisma.refreshToken.findFirst(args);
  }
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
