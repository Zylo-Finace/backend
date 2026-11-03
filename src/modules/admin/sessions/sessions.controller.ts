import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import { IsOptional, IsUUID } from 'class-validator';

import { Permission } from '../../../core/authorization/permission.enum';
import { RequestContext } from '../../../core/context/request-context';
import { AppException } from '../../../core/errors/app.exception';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { AuditService } from '../audit/audit.service';

class SessionQueryDto {
  @IsUUID()
  @IsOptional()
  userId?: string;
}

interface SessionResponse {
  id: string;
  user: { id: string; fullName: string | null; email: string | null };
  deviceName: string | null;
  deviceType: string | null;
  ip: string | null;
  userAgent: string | null;
  isCurrent: boolean;
  lastUsedAt: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Active back-office sessions.
 *
 * The panel needs this for two jobs that look the same but are not: a member
 * reviewing their own devices, and an administrator ending someone else's
 * access during an incident. The second is why `sessions:revoke` is separable
 * from `members:write` — ending a session is the fastest containment step and
 * should not require the ability to also change permissions.
 */
@ApiTags('Admin · Sessions')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@Controller({ path: 'admin/sessions', version: '1' })
export class SessionsController {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.SessionsRead)
  @ApiOperation({
    summary: 'Active sessions',
    description: 'Defaults to the caller’s own. Pass `userId` to review another member’s.',
  })
  async list(@Query() query: SessionQueryDto): Promise<{ items: SessionResponse[] }> {
    const context = RequestContext.getOrThrow();
    const targetUserId = query.userId ?? context.userId;

    const rows = await this.db.session.findMany({
      where: { userId: targetUserId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        deviceName: true,
        deviceType: true,
        ip: true,
        userAgent: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        user: row.user,
        deviceName: row.deviceName,
        deviceType: row.deviceType,
        ip: row.ip,
        userAgent: row.userAgent,
        // Lets the UI label "this device" and warn before ending it.
        isCurrent: row.id === context.sessionId,
        lastUsedAt: row.lastUsedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  @Delete(':id')
  @RequirePermissions(Permission.SessionsRevoke)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End a session' })
  async revoke(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const session = await this.db.session.findFirst({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    });

    if (!session || session.revokedAt) throw AppException.notFound('Session', id);

    await this.db.session.update({
      where: { id },
      data: { revokedAt: new Date(), revokedReason: 'revoked by administrator' },
    });

    await this.audit.record({
      action: 'session.revoked',
      resourceType: 'session',
      resourceId: id,
      metadata: { userId: session.userId },
    });
  }
}
