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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import {
  IsBoolean,
  IsHexColor,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Permission } from '../../../core/authorization/permission.enum';
import { ApiErrorResponse } from '../../../core/dto/api-response.dto';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { TeamsService, type TeamResponse } from './teams.service';

export class CreateTeamDto {
  @ApiProperty({ example: 'Support' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Hex colour used by the UI.', example: '#2563eb' })
  @IsHexColor()
  @IsOptional()
  color?: string;
}

export class UpdateTeamDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(512)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: '#2563eb' })
  @IsHexColor()
  @IsOptional()
  color?: string;
}

export class AddTeamMemberDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ description: 'Team leads receive escalations.', default: false })
  @IsBoolean()
  @IsOptional()
  isLead?: boolean;
}

@ApiTags('Admin · Teams')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@ApiResponse({ status: 403, description: 'Insufficient permissions', type: ApiErrorResponse })
@Controller({ path: 'admin/teams', version: '1' })
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermissions(Permission.TeamsRead)
  @ApiOperation({ summary: 'Every team, with its members' })
  async list(): Promise<{ items: TeamResponse[] }> {
    return { items: await this.teams.list() };
  }

  @Get(':id')
  @RequirePermissions(Permission.TeamsRead)
  @ApiOperation({ summary: 'One team' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<TeamResponse> {
    return this.teams.get(id);
  }

  @Post()
  @RequirePermissions(Permission.TeamsWrite)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a team' })
  @ApiResponse({ status: 409, description: 'Name already in use', type: ApiErrorResponse })
  async create(@Body() dto: CreateTeamDto): Promise<TeamResponse> {
    return this.teams.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.TeamsWrite)
  @ApiOperation({ summary: 'Rename or restyle a team' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamDto,
  ): Promise<TeamResponse> {
    return this.teams.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.TeamsDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a team' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.teams.remove(id);
  }

  @Post(':id/members')
  @RequirePermissions(Permission.TeamsWrite)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a member to a team',
    description: 'Idempotent — re-adding an existing member updates their lead flag.',
  })
  async addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTeamMemberDto,
  ): Promise<TeamResponse> {
    return this.teams.addMember(id, dto.userId, dto.isLead ?? false);
  }

  @Delete(':id/members/:userId')
  @RequirePermissions(Permission.TeamsWrite)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from a team' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.teams.removeMember(id, userId);
  }
}
