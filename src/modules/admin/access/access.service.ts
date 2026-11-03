import { Injectable } from '@nestjs/common';

import {
  ALL_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
} from '../../../core/authorization/permission.enum';
import {
  expandPermissions,
  grants,
  resolveEffectivePermissions,
  type EffectivePermissions,
} from '../../../core/authorization/permission.resolver';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { CacheNamespace } from '../../../infrastructure/cache/cache-key';
import { CacheService } from '../../../infrastructure/cache/cache.service';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';

/**
 * How long a resolved membership is cached.
 *
 * Deliberately short, and deliberately not zero. Permission checks sit in front
 * of every admin route, so an uncached resolution would put a two-table join on
 * all back-office traffic. Sixty seconds bounds how long a revoked permission
 * keeps working; anything that must take effect immediately calls
 * {@link AccessService.invalidate}, which every mutating path here already does.
 */
const ACCESS_CACHE_TTL_SECONDS = 60;

/** The shape cached in Redis. Sets do not survive JSON, so slugs travel as arrays. */
interface CachedAccess {
  membershipId: string;
  roleId: string;
  roleKey: string;
  isOwner: boolean;
  rolePermissions: string[];
  extraPermissions: string[];
  deniedPermissions: string[];
}

export interface ResolvedAccess {
  membershipId: string;
  roleId: string;
  roleKey: string;
  isOwner: boolean;
  effective: EffectivePermissions;
  /** Literal slugs, wildcards expanded — what the UI ticks and hides on. */
  permissions: string[];
}

/**
 * Resolves what a member of a workspace is allowed to do.
 *
 * The single place that answers that question. `PermissionsGuard` uses it on the
 * request path, and every admin service uses it when one member acts on another
 * — because "can this user edit that role" is the same question as "may this
 * request proceed", and answering it twice invites the two answers to diverge.
 */
@Injectable()
export class AccessService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly cache: CacheService,
  ) {}

  /**
   * Loads the caller's grant.
   *
   * @throws AppException(ROLE_REQUIRED) when the user has no membership in this
   *         tenant — authenticated, but not a member of this workspace.
   */
  async resolve(tenantId: string, userId: string): Promise<ResolvedAccess> {
    const cached = await this.load(tenantId, userId);

    const effective = resolveEffectivePermissions({
      rolePermissions: cached.rolePermissions,
      extraPermissions: cached.extraPermissions,
      deniedPermissions: cached.deniedPermissions,
    });

    return {
      membershipId: cached.membershipId,
      roleId: cached.roleId,
      roleKey: cached.roleKey,
      isOwner: cached.isOwner,
      effective,
      permissions: expandPermissions(effective, ALL_PERMISSIONS),
    };
  }

  /** True when the user holds `permission` in this workspace. */
  async can(tenantId: string, userId: string, permission: Permission): Promise<boolean> {
    const access = await this.resolve(tenantId, userId);
    return grants(access.effective, permission);
  }

  /** @throws AppException(INSUFFICIENT_PERMISSIONS) when the user does not hold it. */
  async require(tenantId: string, userId: string, permission: Permission): Promise<void> {
    if (!(await this.can(tenantId, userId, permission))) {
      throw new AppException(ErrorCode.INSUFFICIENT_PERMISSIONS, {
        message: 'You do not have permission to perform this action',
        details: { required: permission },
      });
    }
  }

  /**
   * Drops a member's cached grant.
   *
   * Called by every path that changes a role, a membership or a role's slugs.
   * Missing one does not fail loudly — it leaves stale access for up to a
   * minute — so the invalidation lives next to the write rather than being left
   * to the caller.
   */
  async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.cache.delete(this.key(tenantId, userId));
  }

  /**
   * Drops every cached grant in the workspace.
   *
   * Editing a role changes the grant of everyone holding it, and the membership
   * rows themselves are untouched — so per-user invalidation would need a fan-out
   * query on a write path that is already rare. Clearing the namespace is
   * cheaper and cannot miss a member.
   */
  async invalidateTenant(tenantId: string): Promise<void> {
    await this.cache.invalidateTenantNamespace(tenantId, CacheNamespace.Permissions);
  }

  /**
   * Creates the seeded roles for a workspace, returning the default one.
   *
   * Idempotent: `skipDuplicates` means re-running against a workspace that
   * already has them is a no-op rather than a unique-constraint failure, which
   * matters because this runs during tenant provisioning and provisioning gets
   * retried.
   */
  async seedSystemRoles(tenantId: string): Promise<void> {
    await this.db.role.createMany({
      data: SYSTEM_ROLES.map((role) => ({
        tenantId,
        key: role.key,
        name: role.name,
        description: role.description,
        permissions: [...role.permissions],
        isSystem: true,
        isDefault: role.isDefault,
      })),
      skipDuplicates: true,
    });
  }

  private async load(tenantId: string, userId: string): Promise<CachedAccess> {
    const key = this.key(tenantId, userId);

    const cached = await this.cache.get<CachedAccess>(key);
    if (cached) return cached;

    const membership = await this.db.membership.findFirst({
      where: { tenantId, userId, deletedAt: null },
      select: {
        id: true,
        roleId: true,
        isOwner: true,
        extraPermissions: true,
        deniedPermissions: true,
        role: { select: { key: true, permissions: true, deletedAt: true } },
      },
    });

    if (!membership || membership.role.deletedAt !== null) {
      // Not cached: a user with no membership is either a customer that reached
      // an admin route (already refused by @RequireUserType) or a member who was
      // just removed. Neither is a hot path worth caching, and caching the
      // negative would delay a freshly granted membership taking effect.
      throw new AppException(ErrorCode.ROLE_REQUIRED, {
        message: 'You are not a member of this workspace',
      });
    }

    const access: CachedAccess = {
      membershipId: membership.id,
      roleId: membership.roleId,
      roleKey: membership.role.key,
      isOwner: membership.isOwner,
      rolePermissions: membership.role.permissions,
      extraPermissions: membership.extraPermissions,
      deniedPermissions: membership.deniedPermissions,
    };

    await this.cache.set(key, access, { ttlSeconds: ACCESS_CACHE_TTL_SECONDS });
    return access;
  }

  private key(tenantId: string, userId: string): string {
    return this.cache.keys.tenant(tenantId, CacheNamespace.Permissions, userId);
  }
}
