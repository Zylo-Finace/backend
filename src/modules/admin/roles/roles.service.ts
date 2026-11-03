import { Injectable } from '@nestjs/common';

import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  WILDCARD_PERMISSION,
  isKnownPermission,
  type PermissionGroup,
} from '../../../core/authorization/permission.enum';
import { grants } from '../../../core/authorization/permission.resolver';
import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { CreateRoleDto, RoleResponse, UpdateRoleDto } from './dto/role.dto';

@Injectable()
export class RolesService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** The full catalogue, grouped for the role editor. */
  catalogue(): { groups: readonly PermissionGroup[]; permissions: readonly string[] } {
    return { groups: PERMISSION_GROUPS, permissions: ALL_PERMISSIONS };
  }

  async list(): Promise<RoleResponse[]> {
    const roles = await this.db.role.findMany({
      where: { deletedAt: null },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        permissions: true,
        isSystem: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { memberships: true } },
      },
    });

    return roles.map(toResponse);
  }

  async get(id: string): Promise<RoleResponse> {
    const role = await this.db.role.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        permissions: true,
        isSystem: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { memberships: true } },
      },
    });

    if (!role) throw AppException.notFound('Role', id);
    return toResponse(role);
  }

  async create(dto: CreateRoleDto): Promise<RoleResponse> {
    const tenantId = RequestContext.requireTenantId();
    await this.assertGrantable(dto.permissions);

    const existing = await this.db.role.findFirst({
      where: { key: dto.key, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
        message: `A role with the key "${dto.key}" already exists`,
        details: { key: dto.key },
      });
    }

    const role = await this.db.$transaction(async (tx) => {
      // At most one role ever carries the flag, so the previous default is
      // cleared in the same transaction rather than by a constraint Postgres
      // cannot express (a partial unique index would reject the update order).
      if (dto.isDefault) {
        await tx.role.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.role.create({
        data: {
          tenantId,
          key: dto.key,
          name: dto.name,
          description: dto.description,
          permissions: dto.permissions,
          isDefault: dto.isDefault ?? false,
          isSystem: false,
        },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          permissions: true,
          isSystem: true,
          isDefault: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { memberships: true } },
        },
      });
    });

    await this.audit.record({
      action: 'role.created',
      resourceType: 'role',
      resourceId: role.id,
      metadata: { key: role.key, permissions: role.permissions },
    });

    return toResponse(role);
  }

  async update(id: string, dto: UpdateRoleDto): Promise<RoleResponse> {
    const tenantId = RequestContext.requireTenantId();
    const before = await this.loadEditable(id);

    if (dto.permissions) await this.assertGrantable(dto.permissions);

    const role = await this.db.$transaction(async (tx) => {
      // At most one role ever carries the flag, so the previous default is
      // cleared in the same transaction rather than by a constraint Postgres
      // cannot express (a partial unique index would reject the update order).
      if (dto.isDefault) {
        await tx.role.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.role.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          permissions: dto.permissions,
          isDefault: dto.isDefault,
        },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          permissions: true,
          isSystem: true,
          isDefault: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { memberships: true } },
        },
      });
    });

    // Everyone holding this role has a different grant now, and the membership
    // rows did not change — so per-user invalidation has nothing to key on.
    await this.access.invalidateTenant(tenantId);

    await this.audit.record({
      action: 'role.updated',
      resourceType: 'role',
      resourceId: id,
      changes: AuditService.diff(before, {
        name: dto.name,
        description: dto.description,
        permissions: dto.permissions,
        isDefault: dto.isDefault,
      }),
    });

    return toResponse(role);
  }

  /**
   * Soft-deletes a role.
   *
   * Refused while anyone still holds it. Reassigning those members automatically
   * would be a silent privilege change for every one of them — the operator must
   * choose the replacement role deliberately.
   */
  async remove(id: string): Promise<void> {
    const tenantId = RequestContext.requireTenantId();
    const role = await this.loadEditable(id);

    const memberCount = await this.db.membership.count({
      where: { roleId: id, deletedAt: null },
    });

    if (memberCount > 0) {
      throw AppException.conflict(
        `This role is still assigned to ${memberCount} member${memberCount === 1 ? '' : 's'}. Move them to another role first.`,
        { memberCount },
      );
    }

    if (role.isDefault) {
      throw AppException.conflict(
        'This is the default role for new members. Make another role the default first.',
      );
    }

    await this.db.role.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.access.invalidateTenant(tenantId);

    await this.audit.record({
      action: 'role.deleted',
      resourceType: 'role',
      resourceId: id,
      metadata: { key: role.key },
    });
  }

  /** Loads a role, refusing if it is seeded or already gone. */
  private async loadEditable(id: string): Promise<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    permissions: string[];
    isDefault: boolean;
  }> {
    const role = await this.db.role.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        permissions: true,
        isSystem: true,
        isDefault: true,
      },
    });

    if (!role) throw AppException.notFound('Role', id);

    if (role.isSystem) {
      // Seeded roles are the floor the rest of the system assumes exists —
      // `owner` in particular is what makes a workspace recoverable after a
      // misconfiguration.
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: `"${role.name}" is a built-in role and cannot be modified. Duplicate it instead.`,
        details: { roleKey: role.key },
      });
    }

    return role;
  }

  /**
   * Refuses to grant a permission the caller does not itself hold.
   *
   * Without this, `roles:write` is equivalent to `*`: any member who can edit a
   * role can write `wallets:adjust` into one and assign it to themselves. This
   * is the single check that keeps role editing from being a privilege
   * escalation primitive.
   */
  private async assertGrantable(permissions: readonly string[]): Promise<void> {
    const unknown = permissions.filter(
      (slug) => slug !== WILDCARD_PERMISSION && !slug.endsWith(':*') && !isKnownPermission(slug),
    );

    if (unknown.length > 0) {
      throw AppException.validation('Unknown permissions', { unknown });
    }

    const context = RequestContext.getOrThrow();
    if (!context.tenantId || !context.userId) {
      throw AppException.unauthenticated('No authenticated member on this request');
    }

    const caller = await this.access.resolve(context.tenantId, context.userId);

    // The wildcard is only grantable by someone who already holds it, or it
    // would be a one-step promotion to full control.
    const escalating = permissions.filter((slug) =>
      slug === WILDCARD_PERMISSION || slug.endsWith(':*')
        ? !caller.effective.isSuperset
        : !grants(caller.effective, slug),
    );

    if (escalating.length > 0) {
      throw new AppException(ErrorCode.INSUFFICIENT_PERMISSIONS, {
        message: 'You cannot grant a permission you do not hold yourself',
        details: { permissions: escalating },
      });
    }
  }
}

function toResponse(role: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: { memberships: number };
}): RoleResponse {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    isSystem: role.isSystem,
    isDefault: role.isDefault,
    memberCount: role._count.memberships,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}
