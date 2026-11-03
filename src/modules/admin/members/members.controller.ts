import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';

import { Permission } from '../../../core/authorization/permission.enum';
import { ApiErrorResponse } from '../../../core/dto/api-response.dto';
import type { OffsetPage } from '../../../core/dto/pagination.dto';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import {
  MemberQueryDto,
  SuspendMemberDto,
  UpdateMemberDto,
  UpdateMemberProfileDto,
  type MemberResponse,
} from './dto/member.dto';
import { MembersService } from './members.service';

@ApiTags('Admin · Members')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@ApiResponse({ status: 403, description: 'Insufficient permissions', type: ApiErrorResponse })
@Controller({ path: 'admin/members', version: '1' })
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /**
   * Declared before `:userId` so the literal segment wins the route match —
   * Express resolves in registration order, and `/me` would otherwise be parsed
   * as a user id and fail the UUID pipe.
   */
  @Get('me')
  @ApiOperation({
    summary: 'The signed-in member, with permissions expanded',
    description:
      'The admin UI drives navigation and control visibility from `permissions`. Wildcards are ' +
      'already resolved to literal slugs, so the client never reimplements the matching rules.',
  })
  async me(): Promise<MemberResponse & { permissions: string[] }> {
    return this.members.me();
  }

  @Get()
  @RequirePermissions(Permission.MembersRead)
  @ApiOperation({
    summary: 'Members of this workspace',
    description: 'Offset-paginated — the admin table needs page numbers and a total.',
  })
  async list(@Query() query: MemberQueryDto): Promise<OffsetPage<MemberResponse>> {
    return this.members.list(query);
  }

  @Get(':userId')
  @RequirePermissions(Permission.MembersRead)
  @ApiOperation({ summary: 'One member' })
  async get(@Param('userId', ParseUUIDPipe) userId: string): Promise<MemberResponse> {
    return this.members.get(userId);
  }

  @Patch(':userId/access')
  @RequirePermissions(Permission.MembersWrite)
  @ApiOperation({
    summary: 'Change a member’s role or permission exceptions',
    description:
      'You cannot grant a permission you do not hold, and you cannot edit your own access.',
  })
  async updateAccess(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ): Promise<MemberResponse> {
    return this.members.updateAccess(userId, dto);
  }

  @Patch(':userId/profile')
  @RequirePermissions(Permission.MembersWrite)
  @ApiOperation({ summary: 'Update a member’s display profile' })
  async updateProfile(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberProfileDto,
  ): Promise<MemberResponse> {
    return this.members.updateProfile(userId, dto);
  }

  @Post(':userId/suspend')
  @RequirePermissions(Permission.MembersWrite)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend a member',
    description: 'Revokes their sessions by default, so the lockout is immediate.',
  })
  @ApiResponse({
    status: 403,
    description: 'The owner cannot be suspended',
    type: ApiErrorResponse,
  })
  async suspend(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SuspendMemberDto,
  ): Promise<MemberResponse> {
    return this.members.suspend(userId, dto);
  }

  @Post(':userId/reinstate')
  @RequirePermissions(Permission.MembersWrite)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return a suspended member to active' })
  async reinstate(@Param('userId', ParseUUIDPipe) userId: string): Promise<MemberResponse> {
    return this.members.reinstate(userId);
  }

  @Post(':userId/transfer-ownership')
  @RequirePermissions(Permission.MembersWrite)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Hand workspace ownership to this member',
    description: 'Only the current owner may call this. Both sides move in one transaction.',
  })
  async transferOwnership(@Param('userId', ParseUUIDPipe) userId: string): Promise<void> {
    await this.members.transferOwnership(userId);
  }

  @Delete(':userId')
  @RequirePermissions(Permission.MembersRemove)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a member from the workspace',
    description:
      'Soft-deletes the membership and revokes sessions. The user record survives because the ' +
      'audit trail references it.',
  })
  async remove(@Param('userId', ParseUUIDPipe) userId: string): Promise<void> {
    await this.members.remove(userId);
  }
}
