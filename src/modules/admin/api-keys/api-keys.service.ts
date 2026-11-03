import { Injectable } from '@nestjs/common';

import { isKnownPermission } from '../../../core/authorization/permission.enum';
import { grants } from '../../../core/authorization/permission.resolver';
import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { CryptoService } from '../../../infrastructure/security/crypto.service';
import { HashingService } from '../../../infrastructure/security/hashing.service';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { CreateApiKeyDto, RevokeApiKeyDto } from './api-keys.controller';

/** Distinguishes production keys from anything a future sandbox mints. */
const KEY_PREFIX = 'wba_live';

export interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  allowedIps: string[];
  createdBy: { id: string; name: string | null } | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeyResponse {
  /** The full credential, shown exactly once. Only its digest is stored. */
  secret: string;
}

/**
 * Machine credentials for server-to-server access.
 *
 * ## Split key format
 *
 * A key is `wba_live_<prefix>.<secret>`. The prefix is stored in the clear and
 * uniquely indexed, so authentication is one indexed lookup followed by a single
 * Argon2 verification. Hashing alone would force a verification against *every*
 * key in the table — Argon2 is deliberately slow, so that is a denial-of-service
 * vector rather than a performance detail.
 *
 * The prefix is also what makes a leaked key identifiable in a log or a public
 * repository without the secret half being present.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly hashing: HashingService,
  ) {}

  async list(includeRevoked: boolean): Promise<ApiKeyResponse[]> {
    const rows = await this.db.apiKey.findMany({
      where: { deletedAt: null, ...(includeRevoked ? {} : { revokedAt: null }) },
      orderBy: { createdAt: 'desc' },
      select: API_KEY_SELECT,
    });

    return rows.map(toResponse);
  }

  async create(dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    const tenantId = RequestContext.requireTenantId();
    const { userId: actorId } = RequestContext.getOrThrow();

    await this.assertGrantable(dto.permissions);

    // Two independent halves: the prefix identifies, the secret authenticates.
    const prefix = `${KEY_PREFIX}_${this.crypto.randomToken(8)}`;
    const secret = this.crypto.randomToken(32);
    const secretHash = await this.hashing.hash(secret);

    const key = await this.db.apiKey.create({
      data: {
        tenantId,
        name: dto.name,
        prefix,
        secretHash,
        permissions: dto.permissions,
        allowedIps: dto.allowedIps ?? [],
        createdById: actorId,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
      select: API_KEY_SELECT,
    });

    await this.audit.record({
      action: 'apikey.created',
      resourceType: 'apikey',
      resourceId: key.id,
      metadata: { name: dto.name, prefix, permissions: dto.permissions },
    });

    return { ...toResponse(key), secret: `${prefix}.${secret}` };
  }

  /**
   * Revokes a key.
   *
   * Kept as a row rather than deleted: the audit trail references it, and
   * "which key made this call" stays answerable after the key is retired.
   */
  async revoke(id: string, dto: RevokeApiKeyDto): Promise<ApiKeyResponse> {
    const key = await this.db.apiKey.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, prefix: true, revokedAt: true },
    });

    if (!key) throw AppException.notFound('API key', id);

    if (key.revokedAt) {
      throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, {
        message: 'This key is already revoked',
      });
    }

    const updated = await this.db.apiKey.update({
      where: { id },
      data: { revokedAt: new Date(), revokedReason: dto.reason?.slice(0, 128) },
      select: API_KEY_SELECT,
    });

    await this.audit.record({
      action: 'apikey.revoked',
      resourceType: 'apikey',
      resourceId: id,
      metadata: { name: key.name, prefix: key.prefix, reason: dto.reason },
    });

    return toResponse(updated);
  }

  /**
   * Refuses to mint a key more powerful than its creator.
   *
   * The schema states this invariant ("an API key can never exceed the
   * permissions of the membership that created it"); this is where it is
   * enforced. Without it a key is a way to make your own permissions permanent
   * and unrevokable by role change.
   */
  private async assertGrantable(permissions: readonly string[]): Promise<void> {
    const unknown = permissions.filter((slug) => !isKnownPermission(slug));
    if (unknown.length > 0) {
      throw AppException.validation('Unknown permissions', { unknown });
    }

    const { tenantId, userId } = RequestContext.getOrThrow();
    if (!tenantId || !userId) {
      throw AppException.unauthenticated('No authenticated member on this request');
    }

    const caller = await this.access.resolve(tenantId, userId);
    const escalating = permissions.filter((slug) => !grants(caller.effective, slug));

    if (escalating.length > 0) {
      throw new AppException(ErrorCode.INSUFFICIENT_PERMISSIONS, {
        message: 'An API key cannot be granted permissions you do not hold yourself',
        details: { permissions: escalating },
      });
    }
  }
}

const API_KEY_SELECT = {
  id: true,
  name: true,
  prefix: true,
  permissions: true,
  allowedIps: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  revokedReason: true,
  createdAt: true,
  createdBy: { select: { id: true, fullName: true } },
} as const;

function toResponse(row: {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  allowedIps: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  createdBy: { id: string; fullName: string | null } | null;
}): ApiKeyResponse {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions,
    allowedIps: row.allowedIps,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.fullName } : null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt.toISOString(),
  };
}
