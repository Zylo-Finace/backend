import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';

import { isKnownPermission } from '../../../core/authorization/permission.enum';
import { grants } from '../../../core/authorization/permission.resolver';
import { RequestContext } from '../../../core/context/request-context';
import { buildOffsetPage, type OffsetPage } from '../../../core/dto/pagination.dto';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type {
  MemberQueryDto,
  MemberResponse,
  SuspendMemberDto,
  UpdateMemberDto,
  UpdateMemberProfileDto,
} from './dto/member.dto';

const MEMBER_SELECT = {
  id: true,
  isOwner: true,
  joinedAt: true,
  extraPermissions: true,
  deniedPermissions: true,
  role: { select: { id: true, key: true, name: true } },
  user: {
    select: {
      id: true,
      email: true,
      fullName: true,
      avatarUrl: true,
      status: true,
      lastLoginAt: true,
      teamMembers: {
        select: { isLead: true, team: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.MembershipSelect;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof MEMBER_SELECT }>;

/**
 * Back-office members — the people with access to this workspace.
 *
 * Distinct from customers, who are reached over WhatsApp and never sign in here.
 * The two populations share the `users` table but nothing about their lifecycle,
 * so they get separate services rather than one with a `type` parameter
 * threaded through every method.
 */
@Injectable()
export class MembersService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(query: MemberQueryDto): Promise<OffsetPage<MemberResponse>> {
    const where: Prisma.MembershipWhereInput = {
      deletedAt: null,
      ...(query.roleId ? { roleId: query.roleId } : {}),
      user: {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { fullName: { contains: query.search, mode: 'insensitive' } },
                { email: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
    };

    const [rows, total] = await Promise.all([
      this.db.membership.findMany({
        where,
        select: MEMBER_SELECT,
        orderBy: [{ isOwner: 'desc' }, { joinedAt: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.db.membership.count({ where }),
    ]);

    return buildOffsetPage(rows.map(toResponse), total, query);
  }

  async get(userId: string): Promise<MemberResponse> {
    const membership = await this.db.membership.findFirst({
      where: { userId, deletedAt: null },
      select: MEMBER_SELECT,
    });

    if (!membership) throw AppException.notFound('Member', userId);
    return toResponse(membership);
  }

  /** The caller's own record, with permissions expanded for the UI. */
  async me(): Promise<MemberResponse & { permissions: string[] }> {
    const { tenantId, userId } = RequestContext.getOrThrow();
    if (!tenantId || !userId) {
      throw AppException.unauthenticated('No authenticated member on this request');
    }

    const [member, access] = await Promise.all([
      this.get(userId),
      this.access.resolve(tenantId, userId),
    ]);

    return { ...member, permissions: access.permissions };
  }

  /** Changes a member's role or their per-member permission exceptions. */
  async updateAccess(userId: string, dto: UpdateMemberDto): Promise<MemberResponse> {
    const tenantId = RequestContext.requireTenantId();
    const membership = await this.loadMutable(userId);

    if (dto.roleId) {
      const role = await this.db.role.findFirst({
        where: { id: dto.roleId, deletedAt: null },
        select: { id: true, permissions: true },
      });
      if (!role) throw AppException.notFound('Role', dto.roleId);

      await this.assertGrantable(role.permissions);
    }

    if (dto.extraPermissions) await this.assertGrantable(dto.extraPermissions);
    if (dto.deniedPermissions) assertKnown(dto.deniedPermissions);

    const updated = await this.db.membership.update({
      where: { id: membership.id },
      data: {
        roleId: dto.roleId,
        extraPermissions: dto.extraPermissions,
        deniedPermissions: dto.deniedPermissions,
      },
      select: MEMBER_SELECT,
    });

    await this.access.invalidate(tenantId, userId);

    await this.audit.record({
      action: 'member.access_changed',
      resourceType: 'membership',
      resourceId: membership.id,
      changes: AuditService.diff(
        {
          roleId: membership.role.id,
          extraPermissions: membership.extraPermissions,
          deniedPermissions: membership.deniedPermissions,
        },
        {
          roleId: dto.roleId,
          extraPermissions: dto.extraPermissions,
          deniedPermissions: dto.deniedPermissions,
        },
      ),
      metadata: { userId },
    });

    return toResponse(updated);
  }

  async updateProfile(userId: string, dto: UpdateMemberProfileDto): Promise<MemberResponse> {
    await this.loadMutable(userId, { allowSelf: true, allowOwner: true });

    await this.db.user.update({
      where: { id: userId },
      data: { fullName: dto.fullName, timezone: dto.timezone, locale: dto.locale },
    });

    await this.audit.record({
      action: 'member.profile_updated',
      resourceType: 'user',
      resourceId: userId,
      metadata: { fields: Object.keys(dto) },
    });

    return this.get(userId);
  }

  /**
   * Suspends a member and, by default, ends their sessions.
   *
   * Status alone is not enough to lock someone out promptly: `JwtAuthGuard`
   * caches the principal for 30 seconds and an access token outlives that. For a
   * suspension that is being performed *because* of an incident, 30 seconds of
   * continued access is the wrong default.
   */
  async suspend(userId: string, dto: SuspendMemberDto): Promise<MemberResponse> {
    const membership = await this.loadMutable(userId);

    if (membership.isOwner) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'The workspace owner cannot be suspended. Transfer ownership first.',
      });
    }

    const revokedSessions = await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: UserStatus.SUSPENDED } });

      if (dto.revokeSessions === false) return 0;

      const result = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'member suspended' },
      });
      return result.count;
    });

    await this.audit.record({
      action: 'member.suspended',
      resourceType: 'user',
      resourceId: userId,
      metadata: { reason: dto.reason, revokedSessions },
    });

    return this.get(userId);
  }

  async reinstate(userId: string): Promise<MemberResponse> {
    await this.loadMutable(userId);

    await this.db.user.update({ where: { id: userId }, data: { status: UserStatus.ACTIVE } });

    await this.audit.record({
      action: 'member.reinstated',
      resourceType: 'user',
      resourceId: userId,
    });

    return this.get(userId);
  }

  /**
   * Removes a member from the workspace.
   *
   * Soft-deletes the membership and revokes sessions; the `User` row survives
   * because it is referenced by audit entries, and deleting it would rewrite
   * history to say the actions were performed by nobody.
   */
  async remove(userId: string): Promise<void> {
    const tenantId = RequestContext.requireTenantId();
    const membership = await this.loadMutable(userId);

    if (membership.isOwner) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'The workspace owner cannot be removed. Transfer ownership first.',
      });
    }

    await this.db.$transaction(async (tx) => {
      await tx.membership.update({
        where: { id: membership.id },
        data: { deletedAt: new Date() },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'membership removed' },
      });
      await tx.teamMember.deleteMany({ where: { userId } });
    });

    await this.access.invalidate(tenantId, userId);

    await this.audit.record({
      action: 'member.removed',
      resourceType: 'membership',
      resourceId: membership.id,
      metadata: { userId },
    });
  }

  /**
   * Hands ownership to another member.
   *
   * Both sides move in one transaction. A workspace with two owners is
   * recoverable; a workspace with none is not, and that is exactly what a
   * half-applied transfer produces.
   */
  async transferOwnership(toUserId: string): Promise<void> {
    const tenantId = RequestContext.requireTenantId();
    const { userId: actorId } = RequestContext.getOrThrow();

    const current = await this.db.membership.findFirst({
      where: { userId: actorId, deletedAt: null },
      select: { id: true, isOwner: true },
    });

    if (!current?.isOwner) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'Only the current owner can transfer ownership',
      });
    }

    const target = await this.db.membership.findFirst({
      where: { userId: toUserId, deletedAt: null },
      select: { id: true, user: { select: { status: true } } },
    });

    if (!target) throw AppException.notFound('Member', toUserId);
    if (target.user.status !== UserStatus.ACTIVE) {
      throw AppException.conflict('Ownership can only be transferred to an active member');
    }

    const ownerRole = await this.db.role.findFirst({
      where: { key: 'owner', deletedAt: null },
      select: { id: true },
    });

    await this.db.$transaction([
      this.db.membership.update({ where: { id: current.id }, data: { isOwner: false } }),
      this.db.membership.update({
        where: { id: target.id },
        data: { isOwner: true, ...(ownerRole ? { roleId: ownerRole.id } : {}) },
      }),
    ]);

    await this.access.invalidateTenant(tenantId);

    await this.audit.record({
      action: 'workspace.ownership_transferred',
      resourceType: 'membership',
      resourceId: target.id,
      metadata: { from: actorId, to: toUserId },
    });
  }

  /**
   * Loads a membership for mutation, refusing self-targeting by default.
   *
   * Editing your own access is how an accidental lockout happens — and, more
   * importantly, self-suspension and self-removal let a member under
   * investigation destroy their own access path before it can be reviewed.
   */
  private async loadMutable(
    userId: string,
    options: { allowSelf?: boolean; allowOwner?: boolean } = {},
  ): Promise<MemberRow> {
    const { userId: actorId } = RequestContext.getOrThrow();

    if (userId === actorId && !options.allowSelf) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'You cannot change your own access. Ask another administrator.',
      });
    }

    const membership = await this.db.membership.findFirst({
      where: { userId, deletedAt: null },
      select: MEMBER_SELECT,
    });

    if (!membership) throw AppException.notFound('Member', userId);

    if (membership.isOwner && !options.allowOwner && userId !== actorId) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'The workspace owner’s access cannot be changed by another member',
      });
    }

    return membership;
  }

  /** Same escalation rule as role editing — see `RolesService.assertGrantable`. */
  private async assertGrantable(permissions: readonly string[]): Promise<void> {
    assertKnown(permissions);

    const { tenantId, userId } = RequestContext.getOrThrow();
    if (!tenantId || !userId) {
      throw AppException.unauthenticated('No authenticated member on this request');
    }

    const caller = await this.access.resolve(tenantId, userId);
    const escalating = permissions.filter((slug) =>
      slug === '*' || slug.endsWith(':*')
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

function assertKnown(permissions: readonly string[]): void {
  const unknown = permissions.filter(
    (slug) => slug !== '*' && !slug.endsWith(':*') && !isKnownPermission(slug),
  );

  if (unknown.length > 0) {
    throw AppException.validation('Unknown permissions', { unknown });
  }
}

function toResponse(row: MemberRow): MemberResponse {
  return {
    userId: row.user.id,
    membershipId: row.id,
    email: row.user.email,
    fullName: row.user.fullName,
    avatarUrl: row.user.avatarUrl,
    status: row.user.status,
    isOwner: row.isOwner,
    role: row.role,
    extraPermissions: row.extraPermissions,
    deniedPermissions: row.deniedPermissions,
    teams: row.user.teamMembers.map((membership) => ({
      id: membership.team.id,
      name: membership.team.name,
      isLead: membership.isLead,
    })),
    lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
    joinedAt: row.joinedAt.toISOString(),
  };
}
