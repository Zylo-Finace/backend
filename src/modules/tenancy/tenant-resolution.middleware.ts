import { Injectable, type NestMiddleware } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { HttpHeader } from '../../core/constants/http-header.constants';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { CacheNamespace } from '../../infrastructure/cache/cache-key';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/** Cached tenant lookups. Short enough that a suspension takes effect promptly. */
const TENANT_CACHE_TTL_SECONDS = 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Infrastructure hostnames that are never tenant slugs. */
const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'localhost',
  'staging',
  'dev',
  'test',
  'cdn',
  'static',
  'mail',
]);

/** Platform hosts whose first label is the service name, not a tenant. */
const PLATFORM_HOST_SUFFIXES = ['.up.railway.app', '.railway.app', '.railway.internal'];

/** Paths that must never require a tenant (probes, scrapers). */
const TENANTLESS_PATH_PREFIXES = ['/health', '/metrics', '/whatsapp', '/api/whatsapp'];

interface ResolvedTenant {
  id: string;
  slug: string;
  status: TenantStatus;
}

/**
 * Establishes which tenant a request belongs to, before authentication.
 *
 * ## Why before auth
 *
 * Login endpoints need the tenant *to find the user*: the lookup is
 * `WHERE tenant_id = ? AND phone_e164 = ?`, and identity is unique only within a
 * tenant. So resolution cannot wait for a token that does not exist yet.
 *
 * ## Resolution order
 *
 * 1. `X-Tenant-Id` / `X-Tenant-Slug` header — API clients and the admin console.
 * 2. Subdomain (`acme.api.example.com` → `acme`) — browser traffic.
 *
 * A JWT also carries the tenant, but it is *not* consulted here: the token is
 * unverified at middleware time. The guard cross-checks the token's `tid` against
 * what was resolved here and rejects a mismatch (`TENANT_MISMATCH`), which is what
 * stops a valid token for tenant A being replayed against tenant B's data.
 *
 * ## Unresolved is not an error here
 *
 * Public routes (health, docs, Meta's webhook) have no tenant. This middleware
 * therefore resolves when it can and stays silent when it cannot; enforcement is
 * the guard's job, and ultimately the Prisma extension's, which fails closed on
 * any tenant-scoped query with no tenant in context.
 */
@Injectable()
export class TenantResolutionMiddleware implements NestMiddleware {
  constructor(
    // The unscoped client: `Tenant` is the one table that cannot be tenant-scoped,
    // since resolving the tenant is what this code is doing.
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const path = req.path ?? req.url?.split('?')[0] ?? '';
    if (
      TENANTLESS_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    ) {
      next();
      return;
    }

    const identifier = this.extractIdentifier(req);

    if (identifier) {
      const tenant = await this.resolve(identifier);

      if (!tenant) {
        throw new AppException(ErrorCode.TENANT_NOT_FOUND, {
          message: 'Unknown tenant',
        });
      }

      if (tenant.status === TenantStatus.SUSPENDED || tenant.status === TenantStatus.CANCELLED) {
        throw new AppException(ErrorCode.TENANT_SUSPENDED, {
          message: 'This workspace is not currently active',
        });
      }

      RequestContext.patch({ tenantId: tenant.id });
      RequestContext.addLogFields({ tenantSlug: tenant.slug });
    }

    next();
  }

  /** Header wins over subdomain: it is explicit, and CDNs rewrite hosts. */
  private extractIdentifier(req: Request): { id?: string; slug?: string } | undefined {
    const headerId = header(req, HttpHeader.TenantId);
    if (headerId && UUID_PATTERN.test(headerId)) {
      return { id: headerId };
    }

    const headerSlug = header(req, 'x-tenant-slug')?.toLowerCase();
    if (headerSlug && SLUG_PATTERN.test(headerSlug)) {
      return { slug: headerSlug };
    }

    const host = req.hostname?.toLowerCase();
    if (!host) return undefined;

    // An IPv4 host is not a domain. Without this, `127.0.0.1` parses as the
    // subdomain `127`, and every request that reaches the service by IP — a load
    // balancer probe, an internal service call, a test client — is rejected as an
    // unknown tenant.
    if (IPV4_PATTERN.test(host)) return undefined;

    // Railway (and similar) put the *service* name in the first label:
    // `zylo-production.up.railway.app` is not tenant `zylo-production`.
    if (PLATFORM_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return undefined;
    }

    const [subdomain, ...rest] = host.split('.');
    // Needs at least `sub.domain.tld`, and the label must not be an infrastructure
    // name that would otherwise be looked up on every request.
    if (
      subdomain &&
      rest.length >= 2 &&
      SLUG_PATTERN.test(subdomain) &&
      // A tenant slug always contains a letter; a purely numeric label is far
      // more likely to be an address fragment than a workspace.
      /[a-z]/.test(subdomain) &&
      !RESERVED_SUBDOMAINS.has(subdomain)
    ) {
      return { slug: subdomain };
    }

    return undefined;
  }

  /**
   * Looks the tenant up, cached.
   *
   * Every single request hits this path, so an uncached lookup would add a query
   * to 100% of traffic. Cached negatively as well: an unknown slug being hammered
   * by a scanner must not become an unbounded stream of database queries.
   */
  private async resolve(identifier: {
    id?: string;
    slug?: string;
  }): Promise<ResolvedTenant | null> {
    const key = identifier.id
      ? this.cache.keys.global(CacheNamespace.Tenant, 'id', identifier.id)
      : this.cache.keys.global(CacheNamespace.Tenant, 'slug', identifier.slug!);

    const cached = await this.cache.get<ResolvedTenant | { missing: true }>(key);
    if (cached) {
      return 'missing' in cached ? null : cached;
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: identifier.id ? { id: identifier.id } : { slug: identifier.slug },
      select: { id: true, slug: true, status: true, deletedAt: true },
    });

    if (!tenant || tenant.deletedAt) {
      // Shorter TTL for misses: a tenant that is created moments later should
      // become reachable quickly.
      await this.cache.set(key, { missing: true }, { ttlSeconds: 15 });
      return null;
    }

    const resolved: ResolvedTenant = {
      id: tenant.id,
      slug: tenant.slug,
      status: tenant.status,
    };
    await this.cache.set(key, resolved, { ttlSeconds: TENANT_CACHE_TTL_SECONDS });
    return resolved;
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
