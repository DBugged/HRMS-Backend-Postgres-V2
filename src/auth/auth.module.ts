import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    // Signing options are passed explicitly per-call in AuthService
    // (different secret/TTL for access vs refresh isn't expressible via a
    // single module-level JwtModule config), so this registration just
    // makes JwtService available for injection.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAccessStrategy],
  exports: [AuthService],
})
export class AuthModule {}
