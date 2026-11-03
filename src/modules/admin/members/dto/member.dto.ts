import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { OffsetPaginationQueryDto } from '../../../../core/dto/pagination.dto';

export class MemberQueryDto extends OffsetPaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches name or email, case-insensitive.' })
  @IsString()
  @MaxLength(256)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;

  @ApiPropertyOptional({ description: 'Only members holding this role.' })
  @IsUUID()
  @IsOptional()
  roleId?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ description: 'Move the member to a different role.' })
  @IsUUID()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({
    description: 'Permission slugs granted on top of the role, for one-off exceptions.',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsOptional()
  extraPermissions?: string[];

  @ApiPropertyOptional({
    description: 'Permission slugs withheld from the role. Denials beat every grant.',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsOptional()
  deniedPermissions?: string[];
}

export class UpdateMemberProfileDto {
  @ApiPropertyOptional({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @IsOptional()
  fullName?: string;

  @ApiPropertyOptional({ maxLength: 64, example: 'Africa/Lagos' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ maxLength: 16, example: 'en' })
  @IsString()
  @MaxLength(16)
  @IsOptional()
  locale?: string;
}

export class SuspendMemberDto {
  @ApiProperty({ description: 'Shown in the audit trail. Not shown to the member.' })
  @IsString()
  @MinLength(3)
  @MaxLength(512)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Also revoke every active session, signing them out immediately.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  revokeSessions?: boolean;
}

export interface MemberResponse {
  userId: string;
  membershipId: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  isOwner: boolean;
  role: { id: string; key: string; name: string } | null;
  extraPermissions: string[];
  deniedPermissions: string[];
  teams: { id: string; name: string; isLead: boolean }[];
  lastLoginAt: string | null;
  joinedAt: string;
}
