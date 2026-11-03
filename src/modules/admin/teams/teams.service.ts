import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { ErrorCode } from '../../../core/errors/error-code.enum';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { CreateTeamDto, UpdateTeamDto } from './teams.controller';

const TEAM_SELECT = {
  id: true,
  name: true,
  description: true,
  color: true,
  createdAt: true,
  members: {
    select: {
      isLead: true,
      user: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
    },
  },
} satisfies Prisma.TeamSelect;

type TeamRow = Prisma.TeamGetPayload<{ select: typeof TEAM_SELECT }>;

export interface TeamResponse {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  members: {
    userId: string;
    fullName: string | null;
    email: string | null;
    avatarUrl: string | null;
    isLead: boolean;
  }[];
  createdAt: string;
}

/**
 * Teams — the routing groups conversations are assigned to.
 *
 * Membership of a team carries no permissions of its own. That is deliberate:
 * conflating "who handles this queue" with "what they may do" is how an
 * organisation ends up granting refund rights by adding someone to a rota.
 */
@Injectable()
export class TeamsService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<TeamResponse[]> {
    const teams = await this.db.team.findMany({
      where: { deletedAt: null },
      select: TEAM_SELECT,
      orderBy: { name: 'asc' },
    });

    return teams.map(toResponse);
  }

  async get(id: string): Promise<TeamResponse> {
    const team = await this.db.team.findFirst({
      where: { id, deletedAt: null },
      select: TEAM_SELECT,
    });

    if (!team) throw AppException.notFound('Team', id);
    return toResponse(team);
  }

  async create(dto: CreateTeamDto): Promise<TeamResponse> {
    const tenantId = RequestContext.requireTenantId();

    const existing = await this.db.team.findFirst({
      where: { name: dto.name, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
        message: `A team called "${dto.name}" already exists`,
      });
    }

    const team = await this.db.team.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description,
        color: dto.color,
      },
      select: TEAM_SELECT,
    });

    await this.audit.record({
      action: 'team.created',
      resourceType: 'team',
      resourceId: team.id,
      metadata: { name: team.name },
    });

    return toResponse(team);
  }

  async update(id: string, dto: UpdateTeamDto): Promise<TeamResponse> {
    const before = await this.get(id);

    const team = await this.db.team.update({
      where: { id },
      data: { name: dto.name, description: dto.description, color: dto.color },
      select: TEAM_SELECT,
    });

    await this.audit.record({
      action: 'team.updated',
      resourceType: 'team',
      resourceId: id,
      changes: AuditService.diff(
        { name: before.name, description: before.description, color: before.color },
        dto,
      ),
    });

    return toResponse(team);
  }

  async remove(id: string): Promise<void> {
    const team = await this.get(id);

    // Members are detached rather than soft-deleted alongside: `TeamMember` has
    // no `deletedAt`, and leaving live join rows pointing at a deleted team
    // would keep the team showing up in every member's profile.
    await this.db.$transaction([
      this.db.teamMember.deleteMany({ where: { teamId: id } }),
      this.db.team.update({ where: { id }, data: { deletedAt: new Date() } }),
    ]);

    await this.audit.record({
      action: 'team.deleted',
      resourceType: 'team',
      resourceId: id,
      metadata: { name: team.name, detachedMembers: team.members.length },
    });
  }

  async addMember(teamId: string, userId: string, isLead: boolean): Promise<TeamResponse> {
    const tenantId = RequestContext.requireTenantId();
    await this.get(teamId);

    const membership = await this.db.membership.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });

    if (!membership) {
      throw AppException.validation('That user is not a member of this workspace', { userId });
    }

    await this.db.teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      create: { tenantId, teamId, userId, isLead },
      update: { isLead },
    });

    await this.audit.record({
      action: 'team.member_added',
      resourceType: 'team',
      resourceId: teamId,
      metadata: { userId, isLead },
    });

    return this.get(teamId);
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.get(teamId);

    await this.db.teamMember.deleteMany({ where: { teamId, userId } });

    await this.audit.record({
      action: 'team.member_removed',
      resourceType: 'team',
      resourceId: teamId,
      metadata: { userId },
    });
  }
}

function toResponse(team: TeamRow): TeamResponse {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    color: team.color,
    members: team.members.map((member) => ({
      userId: member.user.id,
      fullName: member.user.fullName,
      email: member.user.email,
      avatarUrl: member.user.avatarUrl,
      isLead: member.isLead,
    })),
    createdAt: team.createdAt.toISOString(),
  };
}
