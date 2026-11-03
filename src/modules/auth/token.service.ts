import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { UserType } from '@prisma/client';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { CryptoService } from '../../infrastructure/security/crypto.service';

/**
 * Access-token claims.
 *
 * Deliberately small: a JWT is sent on every request and cannot be revoked before
 * it expires. Permissions are **not** embedded — a role change would otherwise
 * take up to the token's lifetime to take effect, and revoking access during an
 * incident is exactly when you cannot afford to wait. Permissions are resolved
 * per request from a short-TTL cache instead.
 */
export interface AccessTokenPayload {
  /** Subject — user id. */
  sub: string;
  /** Tenant id. Every request is scoped by this, so it must be in the token. */
  tid: string;
  /** User type, so a guard can reject an admin token on a customer route. */
  typ: UserType;
  /** Session id, so a specific device can be revoked. */
  sid: string;
  iat?: number;
  exp?: number;
  iss?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  tid: string;
  sid: string;
  /** Token family — the unit revoked when reuse is detected. */
  fam: string;
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  tokenType: 'Bearer';
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Issues an access/refresh pair.
   *
   * Access and refresh tokens are signed with **separate secrets**. With one
   * shared secret, a refresh token is structurally a valid access token and any
   * endpoint that forgets to check the token's purpose accepts it — a long-lived
   * credential used where a 15-minute one was intended.
   */
  async issuePair(params: {
    userId: string;
    tenantId: string;
    userType: UserType;
    sessionId: string;
    familyId: string;
  }): Promise<TokenPair> {
    const accessPayload: AccessTokenPayload = {
      sub: params.userId,
      tid: params.tenantId,
      typ: params.userType,
      sid: params.sessionId,
    };

    const refreshPayload: RefreshTokenPayload = {
      sub: params.userId,
      tid: params.tenantId,
      sid: params.sessionId,
      fam: params.familyId,
    };

    // TTLs are converted to seconds rather than passed as `"15m"`. `jsonwebtoken`
    // types the string form as a narrow template literal that our validated
    // config string does not satisfy, and a number is unambiguous anyway — there
    // is no chance of `"15"` being read as milliseconds.
    const accessTtlSeconds = parseDurationToSeconds(this.config.security.jwt.accessTtl);

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.config.security.jwt.accessSecret,
        expiresIn: accessTtlSeconds,
        issuer: this.config.security.jwt.issuer,
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.config.security.jwt.refreshSecret,
        expiresIn: this.refreshTtlSeconds,
        issuer: this.config.security.jwt.issuer,
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTtlSeconds,
      tokenType: 'Bearer',
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.security.jwt.accessSecret,
        issuer: this.config.security.jwt.issuer,
      });
    } catch (cause) {
      throw toTokenException(cause);
    }
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    try {
      return await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.security.jwt.refreshSecret,
        issuer: this.config.security.jwt.issuer,
      });
    } catch (cause) {
      throw toTokenException(cause);
    }
  }

  /**
   * The value stored in `Session.refreshTokenHash`.
   *
   * SHA-256 rather than Argon2id: the token is already 256+ bits of signed
   * randomness, so there is nothing to brute-force, and a slow KDF on every
   * refresh would be pure latency. Storing the hash means a database dump cannot
   * be replayed against the refresh endpoint.
   */
  hashRefreshToken(token: string): string {
    return this.crypto.sha256(token);
  }

  newSessionId(): string {
    return randomUUID();
  }

  newFamilyId(): string {
    return randomUUID();
  }

  get refreshTtlSeconds(): number {
    return parseDurationToSeconds(this.config.security.jwt.refreshTtl);
  }
}

/**
 * Maps `jsonwebtoken` failures onto our codes.
 *
 * Expiry is distinguished from invalidity because clients act on it differently:
 * an expired token means "refresh and retry", an invalid one means "log in
 * again". Collapsing both into 401 forces every SDK to guess.
 */
function toTokenException(cause: unknown): AppException {
  const name = cause instanceof Error ? cause.name : '';

  if (name === 'TokenExpiredError') {
    return new AppException(ErrorCode.TOKEN_EXPIRED, {
      message: 'The token has expired',
      cause,
    });
  }
  return new AppException(ErrorCode.TOKEN_INVALID, {
    message: 'The token is invalid',
    cause,
  });
}

/** Converts `15m` / `30d` / `3600s` into seconds. Validated at config load. */
export function parseDurationToSeconds(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)$/.exec(duration);
  if (!match) return 0;

  const value = Number(match[1]);
  const multipliers: Record<string, number> = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3_600,
    d: 86_400,
    w: 604_800,
    y: 31_536_000,
  };
  return Math.floor(value * (multipliers[match[2]!] ?? 0));
}
