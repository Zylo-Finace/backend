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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';

import { Permission, type PermissionGroup } from '../../../core/authorization/permission.enum';
import { ApiErrorResponse } from '../../../core/dto/api-response.dto';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { CreateRoleDto, UpdateRoleDto, type RoleResponse } from './dto/role.dto';
import { RolesService } from './roles.service';

@ApiTags('Admin · Roles')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@ApiResponse({ status: 403, description: 'Insufficient permissions', type: ApiErrorResponse })
@Controller({ path: 'admin/roles', version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions(Permission.RolesRead)
  @ApiOperation({
    summary: 'The permission catalogue, grouped for the role editor',
    description:
      'Served from the same constant the guard enforces, so a permission can never exist ' +
      'without being visible in the picker.',
  })
  catalogue(): { groups: readonly PermissionGroup[]; permissions: readonly string[] } {
    return this.roles.catalogue();
  }

  @Get()
  @RequirePermissions(Permission.RolesRead)
  @ApiOperation({ summary: 'Every role in the workspace, with member counts' })
  async list(): Promise<{ items: RoleResponse[] }> {
    return { items: await this.roles.list() };
  }

  @Get(':id')
  @RequirePermissions(Permission.RolesRead)
  @ApiOperation({ summary: 'One role' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<RoleResponse> {
    return this.roles.get(id);
  }

  @Post()
  @RequirePermissions(Permission.RolesWrite)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a role',
    description:
      'You cannot grant a permission you do not hold yourself — otherwise `roles:write` ' +
      'would be a one-step promotion to full control.',
  })
  @ApiResponse({ status: 409, description: 'Key already in use', type: ApiErrorResponse })
  async create(@Body() dto: CreateRoleDto): Promise<RoleResponse> {
    return this.roles.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.RolesWrite)
  @ApiOperation({ summary: 'Update a role' })
  @ApiResponse({
    status: 403,
    description: 'Built-in roles cannot be edited',
    type: ApiErrorResponse,
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleResponse> {
    return this.roles.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.RolesDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a role',
    description: 'Refused while any member still holds it.',
  })
  @ApiResponse({ status: 409, description: 'Role still assigned', type: ApiErrorResponse })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.roles.remove(id);
  }
}
