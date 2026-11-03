import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ALL_PERMISSIONS } from '../../../../core/authorization/permission.enum';

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateRoleDto {
  @ApiProperty({
    description: 'Stable identifier, unique per workspace. Lowercase, dash-separated.',
    example: 'billing-manager',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9-]*$/, {
    message: 'key must be lowercase alphanumeric with dashes, starting with a letter',
  })
  @Transform(lower)
  key!: string;

  @ApiProperty({ example: 'Billing manager' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Permission slugs. Must all exist in the catalogue.',
    enum: ALL_PERMISSIONS,
    isArray: true,
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(200)
  permissions!: string[];

  @ApiPropertyOptional({
    description: 'Assign to new members when no role is named. Unsets the previous default.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'Billing manager' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: ALL_PERMISSIONS, isArray: true })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsOptional()
  permissions?: string[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export interface RoleResponse {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  isDefault: boolean;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}
