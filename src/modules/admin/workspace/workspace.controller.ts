import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { TenantStatus, UserType } from '@prisma/client';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { Permission } from '../../../core/authorization/permission.enum';
import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { AuditService } from '../audit/audit.service';

export class UpdateWorkspaceDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'Africa/Lagos', description: 'IANA zone.' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @MaxLength(16)
  @IsOptional()
  locale?: string;

  @ApiPropertyOptional({
    description: 'Branding and feature toggles. Replaces the object wholesale.',
  })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

interface WorkspaceResponse {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  timezone: string;
  locale: string;
  planKey: string;
  planExpiresAt: string | null;
  settings: unknown;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
}

/**
 * The current workspace.
 *
 * Scoped to the caller's own tenant — there is no `:tenantId` parameter and no
 * cross-tenant listing. A platform-operator console that spans tenants is a
 * genuinely different surface: it needs `runAsSystem` to bypass the Prisma
 * tenant extension, and giving it a route here would mean one missing guard
 * turns a workspace administrator into a platform administrator.
 */
@ApiTags('Admin · Workspace')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@Controller({ path: 'admin/workspace', version: '1' })
export class WorkspaceController {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.WorkspaceRead)
  @ApiOperation({ summary: 'The signed-in member’s workspace' })
  async get(): Promise<WorkspaceResponse> {
    const tenantId = RequestContext.requireTenantId();
    const tenant = await this.db.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: WORKSPACE_SELECT,
    });

    if (!tenant) throw AppException.notFound('Workspace', tenantId);
    return toResponse(tenant);
  }

  @Patch()
  @RequirePermissions(Permission.WorkspaceWrite)
  @ApiOperation({
    summary: 'Update workspace profile and settings',
    description:
      '`slug`, `status` and `planKey` are deliberately not editable here — the first breaks ' +
      'tenant resolution for every existing link, and the last two are owned by billing.',
  })
  async update(@Body() dto: UpdateWorkspaceDto): Promise<WorkspaceResponse> {
    const tenantId = RequestContext.requireTenantId();

    const before = await this.db.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: WORKSPACE_SELECT,
    });
    if (!before) throw AppException.notFound('Workspace', tenantId);

    const tenant = await this.db.tenant.update({
      where: { id: tenantId },
      data: {
        name: dto.name,
        timezone: dto.timezone,
        locale: dto.locale,
        settings: dto.settings as never,
      },
      select: WORKSPACE_SELECT,
    });

    await this.audit.record({
      action: 'workspace.updated',
      resourceType: 'tenant',
      resourceId: tenantId,
      changes: AuditService.diff(
        { name: before.name, timezone: before.timezone, locale: before.locale },
        { name: dto.name, timezone: dto.timezone, locale: dto.locale },
      ),
      metadata: dto.settings ? { settingsReplaced: true } : undefined,
    });

    return toResponse(tenant);
  }
}

const WORKSPACE_SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  timezone: true,
  locale: true,
  planKey: true,
  planExpiresAt: true,
  settings: true,
  suspendedAt: true,
  suspendedReason: true,
  createdAt: true,
} as const;

function toResponse(tenant: {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  timezone: string;
  locale: string;
  planKey: string;
  planExpiresAt: Date | null;
  settings: unknown;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  createdAt: Date;
}): WorkspaceResponse {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    timezone: tenant.timezone,
    locale: tenant.locale,
    planKey: tenant.planKey,
    planExpiresAt: tenant.planExpiresAt?.toISOString() ?? null,
    settings: tenant.settings,
    suspendedAt: tenant.suspendedAt?.toISOString() ?? null,
    suspendedReason: tenant.suspendedReason,
    createdAt: tenant.createdAt.toISOString(),
  };
}
