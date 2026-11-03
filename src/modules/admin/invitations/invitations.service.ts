import { Injectable } from '@nestjs/common';
import { InvitationStatus, UserStatus, UserType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { grants } from '../../../core/authorization/permission.resolver';
import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { CryptoService } from '../../../infrastructure/security/crypto.service';
import { HashingService } from '../../../infrastructure/security/hashing.service';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AcceptInvitationDto, CreateInvitationDto } from './invitations.controller';

/** How long an invitation stays usable. */
const INVITATION_TTL_HOURS = 72;

export interface InvitationResponse {
  id: string;
  email: string;
  status: InvitationStatus;
  role: { id: string; name: string } | null;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface CreatedInvitation extends InvitationResponse {
  /**
   * The raw token, returned **once**.
   *
   * Only the SHA-256 digest is stored, so this value cannot be recovered later —
   * the same reasoning as refresh tokens. Until an email transport exists, the
   * caller is responsible for delivering it; the alternative (storing it in
   * plaintext so it can be re-read) turns a database dump into a set of live
   * workspace invitations.
   */
  token: string;
}

@Injectable()
export class InvitationsService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly hashing: HashingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InvitationsService.name);
  }

  async list(status?: InvitationStatus): Promise<InvitationResponse[]> {
    const rows = await this.db.invitation.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        email: true,
        status: true,
        invitedById: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
        role: { select: { id: true, name: true } },
      },
    });

    return rows.map(toResponse);
  }

  /**
   * Invites someone into the workspace.
   *
   * The inviter must hold every permission the invited role carries — same
   * escalation rule as role editing, and for the same reason: otherwise
   * `invitations:write` grants the ability to mint an account more powerful than
   * your own and sign in as it.
   */
  async create(dto: CreateInvitationDto): Promise<CreatedInvitation> {
    const tenantId = RequestContext.requireTenantId();
    const { userId: actorId } = RequestContext.getOrThrow();
    const email = dto.email.trim().toLowerCase();

    const role = await this.db.role.findFirst({
      where: { id: dto.roleId, deletedAt: null },
      select: { id: true, name: true, permissions: true },
    });
    if (!role) throw AppException.notFound('Role', dto.roleId);

    await this.assertGrantable(role.permissions);

    const existingUser = await this.db.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    if (existingUser) {
      throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
        message: 'Someone with that email address is already in this workspace',
      });
    }

    const pending = await this.db.invitation.findFirst({
      where: { email, status: InvitationStatus.PENDING },
      select: { id: true },
    });
    if (pending) {
      throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
        message: 'An invitation is already pending for that address. Revoke it to send a new one.',
      });
    }

    const token = this.crypto.randomToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);

    const invitation = await this.db.invitation.create({
      data: {
        tenantId,
        email,
        roleId: role.id,
        tokenHash: this.crypto.sha256(token),
        invitedById: actorId,
        expiresAt,
      },
      select: {
        id: true,
        email: true,
        status: true,
        invitedById: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
        role: { select: { id: true, name: true } },
      },
    });

    await this.audit.record({
      action: 'invitation.created',
      resourceType: 'invitation',
      resourceId: invitation.id,
      // The token is deliberately absent — an audit reader must not be able to
      // accept an invitation they merely have permission to read about.
      metadata: { email, roleId: role.id, roleName: role.name },
    });

    return { ...toResponse(invitation), token };
  }

  /** Revokes a pending invitation. Already-accepted invitations are immutable. */
  async revoke(id: string): Promise<InvitationResponse> {
    const invitation = await this.db.invitation.findFirst({
      where: { id },
      select: { id: true, status: true, email: true },
    });

    if (!invitation) throw AppException.notFound('Invitation', id);

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, {
        message: `This invitation is ${invitation.status.toLowerCase()} and can no longer be revoked`,
      });
    }

    const updated = await this.db.invitation.update({
      where: { id },
      data: { status: InvitationStatus.REVOKED },
      select: {
        id: true,
        email: true,
        status: true,
        invitedById: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
        role: { select: { id: true, name: true } },
      },
    });

    await this.audit.record({
      action: 'invitation.revoked',
      resourceType: 'invitation',
      resourceId: id,
      metadata: { email: invitation.email },
    });

    return toResponse(updated);
  }

  /**
   * Accepts an invitation, creating the member.
   *
   * Runs unauthenticated and **outside tenant scope** — the person holding the
   * token has no session and no tenant header yet, so the token itself is what
   * resolves the workspace. It is looked up by digest, and the whole thing is
   * one transaction: a user without a membership can sign in but reach nothing,
   * which is the worst of the possible half-states.
   */
  async accept(dto: AcceptInvitationDto): Promise<{ tenantId: string; userId: string }> {
    const tokenHash = this.crypto.sha256(dto.token);

    return RequestContext.runAsSystem({}, async () => {
      const invitation = await this.prisma.invitation.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          tenantId: true,
          email: true,
          roleId: true,
          status: true,
          expiresAt: true,
        },
      });

      if (!invitation) {
        // Same error for "no such token" and "wrong token": distinguishing them
        // turns this endpoint into an oracle for guessing valid invitations.
        throw new AppException(ErrorCode.TOKEN_INVALID, {
          message: 'This invitation link is not valid',
        });
      }

      if (invitation.status !== InvitationStatus.PENDING) {
        throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, {
          message: `This invitation has already been ${invitation.status.toLowerCase()}`,
        });
      }

      if (invitation.expiresAt <= new Date()) {
        await this.prisma.invitation.update({
          where: { id: invitation.id },
          data: { status: InvitationStatus.EXPIRED },
        });
        throw new AppException(ErrorCode.TOKEN_EXPIRED, {
          message: 'This invitation has expired. Ask for a new one.',
        });
      }

      const passwordHash = await this.hashing.hash(dto.password);

      const userId = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            tenantId: invitation.tenantId,
            type: UserType.ADMIN,
            email: invitation.email,
            emailVerifiedAt: new Date(),
            fullName: dto.fullName,
            passwordHash,
            passwordChangedAt: new Date(),
            // Accepting the invitation *is* the email verification — the address
            // received a token only the holder could have.
            status: UserStatus.ACTIVE,
          },
          select: { id: true },
        });

        await tx.membership.create({
          data: {
            tenantId: invitation.tenantId,
            userId: user.id,
            roleId: invitation.roleId,
            invitedBy: null,
          },
        });

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: InvitationStatus.ACCEPTED, acceptedAt: new Date() },
        });

        return user.id;
      });

      this.logger.info(
        { tenantId: invitation.tenantId, userId },
        'Invitation accepted; member created',
      );

      return { tenantId: invitation.tenantId, userId };
    });
  }

  private async assertGrantable(permissions: readonly string[]): Promise<void> {
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
        message: 'You cannot invite someone to a role more powerful than your own',
        details: { permissions: escalating },
      });
    }
  }
}

function toResponse(row: {
  id: string;
  email: string;
  status: InvitationStatus;
  invitedById: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
  role: { id: string; name: string } | null;
}): InvitationResponse {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    role: row.role,
    invitedBy: row.invitedById,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
