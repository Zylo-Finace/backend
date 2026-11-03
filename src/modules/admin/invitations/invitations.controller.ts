import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiBearerAuth } from '@nestjs/swagger';
import { InvitationStatus, UserType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Permission } from '../../../core/authorization/permission.enum';
import { ApiErrorResponse } from '../../../core/dto/api-response.dto';
import { Public } from '../../../core/decorators/public.decorator';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import {
  InvitationsService,
  type CreatedInvitation,
  type InvitationResponse,
} from './invitations.service';

export class InvitationQueryDto {
  @ApiPropertyOptional({ enum: InvitationStatus })
  @IsEnum(InvitationStatus)
  @IsOptional()
  status?: InvitationStatus;
}

export class CreateInvitationDto {
  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ description: 'The role the invitee joins with.' })
  @IsUUID()
  roleId!: string;
}

export class AcceptInvitationDto {
  @ApiProperty({ description: 'The token from the invitation link.' })
  @IsString()
  @MaxLength(512)
  token!: string;

  @ApiProperty({ minLength: 12, description: 'At least 12 characters.' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsString()
  @MaxLength(160)
  @IsOptional()
  fullName?: string;
}

@ApiTags('Admin · Invitations')
@Controller({ path: 'admin/invitations', version: '1' })
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.ADMIN)
  @RequirePermissions(Permission.InvitationsRead)
  @ApiOperation({ summary: 'Invitations, newest first' })
  async list(@Query() query: InvitationQueryDto): Promise<{ items: InvitationResponse[] }> {
    return { items: await this.invitations.list(query.status) };
  }

  @Post()
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.ADMIN)
  @RequirePermissions(Permission.InvitationsWrite)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invite someone into the workspace',
    description:
      'Returns the raw token **once** — only its digest is stored. You cannot invite someone ' +
      'to a role carrying permissions you do not hold.',
  })
  @ApiResponse({
    status: 409,
    description: 'Already a member or already invited',
    type: ApiErrorResponse,
  })
  async create(@Body() dto: CreateInvitationDto): Promise<CreatedInvitation> {
    return this.invitations.create(dto);
  }

  @Post(':id/revoke')
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.ADMIN)
  @RequirePermissions(Permission.InvitationsRevoke)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(@Param('id', ParseUUIDPipe) id: string): Promise<InvitationResponse> {
    return this.invitations.revoke(id);
  }

  /**
   * Accepting is necessarily unauthenticated: the invitee has no account yet and
   * no tenant header to send. The token is the only credential, which is why it
   * is high-entropy, single-use and short-lived.
   */
  @Post('accept')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Accept an invitation and create the account',
    description: 'Sign in at `/auth/admin/login` with an allowlisted phone and transfer PIN.',
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired token', type: ApiErrorResponse })
  async accept(@Body() dto: AcceptInvitationDto): Promise<{ tenantId: string; userId: string }> {
    return this.invitations.accept(dto);
  }
}
