import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { Permission } from '../../../core/authorization/permission.enum';
import {
  buildCursorPage,
  CursorPaginationQueryDto,
  type CursorPage,
} from '../../../core/dto/pagination.dto';
import { Cursor } from '../../../core/utils/cursor.util';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';

export class AuditQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({ description: 'Exact action, e.g. `role.updated`.' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  action?: string;

  @ApiPropertyOptional({ description: 'Filter to one resource type, e.g. `role`.' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  resourceType?: string;

  @ApiPropertyOptional({ description: 'Filter to one record. Requires `resourceType`.' })
  @IsString()
  @MaxLength(128)
  @IsOptional()
  resourceId?: string;

  @ApiPropertyOptional({ description: 'Only entries written by this member.' })
  @IsUUID()
  @IsOptional()
  actorId?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound, ISO 8601.' })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Exclusive upper bound, ISO 8601.' })
  @IsISO8601()
  @IsOptional()
  to?: string;
}

interface AuditEntryResponse {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actor: { id: string | null; type: string; email: string | null; name: string | null };
  changes: unknown;
  metadata: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

/**
 * The audit trail, read-only.
 *
 * There is deliberately no write endpoint and no delete endpoint. Entries are
 * written by {@link AuditService} as a side effect of the operation being
 * audited; an API that let a client post its own entries would make the trail
 * worth exactly as much as the client's honesty.
 */
@ApiTags('Admin · Audit')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@Controller({ path: 'admin/audit-logs', version: '1' })
export class AuditController {
  constructor(@InjectPrisma() private readonly db: ExtendedPrismaClient) {}

  @Get()
  @RequirePermissions(Permission.AuditRead)
  @ApiOperation({
    summary: 'Audit trail, newest first',
    description:
      'Cursor-paginated. Filters compose; `resourceId` is only meaningful alongside `resourceType`, ' +
      'which is how the composite index is ordered.',
  })
  async list(@Query() query: AuditQueryDto): Promise<CursorPage<AuditEntryResponse>> {
    const cursor = query.cursor ? Cursor.toDate(query.cursor) : undefined;

    const rows = await this.db.auditLog.findMany({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lt: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.date } },
                { createdAt: cursor.date, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        action: true,
        resourceType: true,
        resourceId: true,
        actorType: true,
        actorId: true,
        actorEmail: true,
        changes: true,
        metadata: true,
        ip: true,
        requestId: true,
        createdAt: true,
        actor: { select: { fullName: true, email: true } },
      },
    });

    const page = buildCursorPage(rows, query.limit, (row) =>
      Cursor.fromDate(row.createdAt, row.id),
    );

    return {
      items: page.items.map((row) => ({
        id: row.id,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        actor: {
          id: row.actorId,
          type: row.actorType,
          // `actorEmail` is a denormalised snapshot — it preserves the address as
          // it was when the action happened, which survives a later email change
          // or a removed member. `AuditService` does not populate it (the context
          // carries no email, and resolving one would add a query to every
          // audited write), so today this resolves through the join; the column
          // is preferred when present so backfilled rows read correctly.
          email: row.actorEmail ?? row.actor?.email ?? null,
          name: row.actor?.fullName ?? null,
        },
        changes: row.changes,
        metadata: row.metadata,
        ip: row.ip,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: page.meta,
    };
  }

  @Get('actions')
  @RequirePermissions(Permission.AuditRead)
  @ApiOperation({
    summary: 'Distinct actions present in the trail',
    description: 'Populates the filter dropdown without the UI hard-coding the action list.',
  })
  async actions(): Promise<{ actions: string[]; resourceTypes: string[] }> {
    const [actions, resourceTypes] = await Promise.all([
      this.db.auditLog.findMany({ distinct: ['action'], select: { action: true }, take: 200 }),
      this.db.auditLog.findMany({
        distinct: ['resourceType'],
        select: { resourceType: true },
        take: 200,
      }),
    ]);

    return {
      actions: actions.map((row) => row.action).sort(),
      resourceTypes: resourceTypes.map((row) => row.resourceType).sort(),
    };
  }
}
