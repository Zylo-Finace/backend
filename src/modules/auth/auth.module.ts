import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { RewardsModule } from '../rewards/rewards.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TokenService } from './token.service';

/**
 * Authentication for customers (phone + PIN) and admins (email + password).
 *
 * `JwtModule` is registered without a secret on purpose: access and refresh
 * tokens are signed with *different* secrets, so each is passed explicitly at
 * sign/verify time by `TokenService`. A module-level default would make it easy
 * to sign a refresh token with the access secret by omission — and a refresh
 * token that verifies as an access token is a long-lived credential used where a
 * 15-minute one was intended.
 */
@Module({
  imports: [JwtModule.register({}), RewardsModule],
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtAuthGuard],
  exports: [AuthService, TokenService, JwtAuthGuard],
})
export class AuthModule {}
