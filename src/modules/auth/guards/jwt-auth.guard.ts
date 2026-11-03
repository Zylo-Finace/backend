import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserStatus, type UserType } from '@prisma/client';
import type { Request } from 'express';

import { ActorType, RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { CacheNamespace } from '../../../infrastructure/cache/cache-key';
import { CacheService } from '../../../infrastructure/cache/cache.service';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { IS_PUBLIC } from '../../../core/decorators/public.decorator';
import { REQUIRED_USER_TYPES } from '../decorators/user-type.decorator';
import { TokenService } from '../token.service';

/** How long a validated principal is cached. Bounds the revocation window. */
const PRINCIPAL_CACHE_TTL_SECONDS = 30;

interface CachedPrincipal {
  userId: string;
  tenantId: string;
  type: UserType;
  status: UserStatus;
  sessionId: string;
}

/**
 * Authenticates a request from its bearer token and populates the request context.
 *
 * Registered globally: **every route is protected unless explicitly marked
 * `@Public()`**. The inverse — opt-in protection — fails open, and the failure is
 * silent: a new endpoint is simply unauthenticated until someone notices.
 *
 * ## Session checking, and why it is cached rather than skipped
 *
 * A JWT alone cannot express revocation: logout, a PIN change, or a suspension
 * must take effect before the token's natural expiry. So the session is checked —
 * but checking the database on every request would put a query in front of all
 * traffic. The compromise is a 30-second cache: the revocation window is bounded
 * and short, and the steady-state cost is a Redis GET. Security-critical
 * operations (money movement) re-verify directly rather than trusting the cache.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly cache: CacheService,
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request);

    if (!token) {
      throw new AppException(ErrorCode.UNAUTHENTICATED, {
        message: 'Provide a bearer token to access this resource',
      });
    }

    const payload = await this.tokens.verifyAccessToken(token);
    const principal = await this.loadPrincipal(payload.sub, payload.sid, payload.tid);

    // The token names a tenant; the middleware resolved one from the host or
    // header. If they disagree, someone is replaying a valid token against
    // another workspace's data.
    const resolvedTenantId = RequestContext.tenantId;
    if (resolvedTenantId && resolvedTenantId !== payload.tid) {
      throw new AppException(ErrorCode.TENANT_MISMATCH, {
        message: 'This token is not valid for the requested workspace',
      });
    }

    if (principal.status !== UserStatus.ACTIVE) {
      throw new AppException(ErrorCode.ACCOUNT_SUSPENDED, {
        message: 'This account is not active',
      });
    }

    const requiredTypes = this.reflector.getAllAndOverride<UserType[]>(REQUIRED_USER_TYPES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredTypes?.length && !requiredTypes.includes(principal.type)) {
      // Deliberately a 403 with no detail: telling a customer that a route exists
      // for admins is free reconnaissance.
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'You do not have access to this resource',
      });
    }

    RequestContext.patch({
      tenantId: payload.tid,
      userId: principal.userId,
      sessionId: payload.sid,
      actorType: ActorType.User,
    });

    return true;
  }

  /**
   * Resolves the principal behind a token, verifying the session still lives.
   *
   * Cached negatively as well as positively — a revoked session being retried in
   * a loop must not become a query storm.
   */
  private async loadPrincipal(
    userId: string,
    sessionId: string,
    tenantId: string,
  ): Promise<CachedPrincipal> {
    const key = this.cache.keys.tenant(tenantId, CacheNamespace.Session, sessionId);

    const cached = await this.cache.get<CachedPrincipal | { revoked: true }>(key);
    if (cached) {
      if ('revoked' in cached) {
        throw new AppException(ErrorCode.TOKEN_REVOKED, {
          message: 'This session has ended. Please sign in again.',
        });
      }
      return cached;
    }

    const session = await this.db.session.findFirst({
      where: { id: sessionId, userId },
      select: {
        id: true,
        revokedAt: true,
        expiresAt: true,
        user: {
          select: { id: true, tenantId: true, type: true, status: true, deletedAt: true },
        },
      },
    });

    const invalid =
      !session ||
      session.revokedAt !== null ||
      session.expiresAt <= new Date() ||
      session.user.deletedAt !== null;

    if (invalid) {
      await this.cache.set(key, { revoked: true }, { ttlSeconds: PRINCIPAL_CACHE_TTL_SECONDS });
      throw new AppException(ErrorCode.TOKEN_REVOKED, {
        message: 'This session has ended. Please sign in again.',
      });
    }

    const principal: CachedPrincipal = {
      userId: session.user.id,
      tenantId: session.user.tenantId,
      type: session.user.type,
      status: session.user.status,
      sessionId: session.id,
    };

    await this.cache.set(key, principal, { ttlSeconds: PRINCIPAL_CACHE_TTL_SECONDS });
    return principal;
  }
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;

  const [scheme, value] = header.split(' ');
  // Case-insensitive: some HTTP clients normalise the scheme to lowercase.
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}
