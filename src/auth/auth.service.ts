import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthUserDto } from './dto/auth-response.dto';
import { JwtPayload } from '../common/interfaces/jwt-payload.interface';
import {
  REFRESH_TOKEN_TTL_DAYS,
  ACCESS_TOKEN_TTL_SECONDS,
} from './auth.constants';

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    // Organization is not tenant-scoped (it IS the tenant), so this uses
    // the plain PrismaService rather than the extended client.
    private readonly prisma: PrismaService,
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly usersService: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, SALT_ROUNDS);

    // Prisma's interactive $transaction, analogous to the old system's
    // Sequelize transaction wrapping org+founder creation.
    const { organization, user } = await this.prisma.$transaction(
      async (tx) => {
        const organization = await tx.organization.create({
          data: { name: dto.organizationName },
        });
        const user = await tx.user.create({
          data: {
            organizationId: organization.id,
            email: dto.email,
            password: hashedPassword,
            name: dto.name,
            role: Role.ADMIN,
            isFounder: true,
            mustChangePassword: false,
            // Email verification (token + send) is deferred to when Resend
            // infra is added in a later phase — documented simplification,
            // not an oversight. The old system defaults this to false and
            // requires a verify-email click; v2 skips that step for now.
            emailVerified: true,
          },
        });
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
    return safe;
  }

  private async issueTokenPair(
    userId: string,
    organizationId: string,
    role: Role,
    meta: { ip?: string; userAgent?: string },
  ): Promise<IssuedTokens> {
    const payload: JwtPayload = { sub: userId, organizationId, role };
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

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
