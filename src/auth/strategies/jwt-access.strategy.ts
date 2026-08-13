import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { UsersService } from '../../users/users.service';

/**
 * Deliberately re-fetches the user row from the DB on every request rather
 * than trusting the decoded token's role/organizationId claims — directly
 * preserves the old Express backend's `protect` middleware behavior, which
 * the architecture audit called out as worth keeping (avoids a stale-
 * permission bug if a role changes or a user is deactivated mid-session,
 * since the 15-minute access token would otherwise still carry the old
 * claims until it expired).
 */
@Injectable()
export class JwtAccessStrategy extends PassportStrategy(
  Strategy,
  'jwt-access',
) {
  constructor(private readonly usersService: UsersService) {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) throw new Error('JWT_ACCESS_SECRET is not set.');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.usersService.findByIdInOrg(
      payload.sub,
      payload.organizationId,
    );
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Session is no longer valid.');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash deliberately
    const { password, ...safe } = user;
    return safe; // becomes request.user
  }
}
