import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Post,
  Query,
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
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsIP,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ALL_PERMISSIONS, Permission } from '../../../core/authorization/permission.enum';
import { ApiErrorResponse } from '../../../core/dto/api-response.dto';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiKeysService, type ApiKeyResponse, type CreatedApiKey } from './api-keys.service';

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Order service' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: ALL_PERMISSIONS, isArray: true })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(100)
  permissions!: string[];

  @ApiPropertyOptional({
    description:
      'Optional allowlist. Requests from other addresses are refused before authentication.',
    isArray: true,
  })
  @IsArray()
  @IsIP(undefined, { each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  allowedIps?: string[];

  @ApiPropertyOptional({ description: 'ISO 8601. Omit for a key that never expires.' })
  @IsISO8601()
  @IsOptional()
  expiresAt?: string;
}

export class RevokeApiKeyDto {
  @ApiPropertyOptional({ maxLength: 128, description: 'Recorded in the audit trail.' })
  @IsString()
  @MaxLength(128)
  @IsOptional()
  reason?: string;
}

@ApiTags('Admin · API keys')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@ApiResponse({ status: 403, description: 'Insufficient permissions', type: ApiErrorResponse })
@Controller({ path: 'admin/api-keys', version: '1' })
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermissions(Permission.ApiKeysRead)
  @ApiOperation({
    summary: 'API keys',
    description: 'Secrets are never returned — only the public prefix half.',
  })
  async list(
    @Query('includeRevoked', new ParseBoolPipe({ optional: true })) includeRevoked?: boolean,
  ): Promise<{ items: ApiKeyResponse[] }> {
    return { items: await this.keys.list(includeRevoked ?? false) };
  }

  @Post()
  @RequirePermissions(Permission.ApiKeysWrite)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Mint an API key',
    description:
      'The `secret` is returned **once** and cannot be recovered. A key can never carry a ' +
      'permission its creator does not hold.',
  })
  async create(@Body() dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    return this.keys.create(dto);
  }

  @Post(':id/revoke')
  @RequirePermissions(Permission.ApiKeysRevoke)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a key immediately' })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeApiKeyDto,
  ): Promise<ApiKeyResponse> {
    return this.keys.revoke(id, dto);
  }
}
