import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

import { Permission } from '../../core/authorization/permission.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import { RequireAnyPermission } from '../admin/access/require-permissions.decorator';
import { RampRatesService, type RampRatesSnapshot } from './ramp-rates.service';

export class UpdateRampRatesDto {
  @ApiPropertyOptional({ example: 1550, description: 'NGN per USDC when user sells' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(50_000)
  sellRateNgn?: number;

  @ApiPropertyOptional({ example: 1600, description: 'NGN per USDC when user buys' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(50_000)
  buyRateNgn?: number;

  @ApiPropertyOptional({ example: 5000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1_000_000)
  maxOrderUsdc?: number;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  minBankSendNgn?: number;

  @ApiPropertyOptional({ example: 500_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  maxBankSendNgn?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  sellFeeNgn?: number;
}

@ApiTags('Admin · Ramp rates')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@Controller({ path: 'admin/ramp-rates', version: '1' })
export class RampRatesAdminController {
  constructor(private readonly rates: RampRatesService) {}

  @Get()
  @RequireAnyPermission(Permission.WorkspaceRead, Permission.AnalyticsRead, Permission.WalletsRead)
  @ApiOperation({ summary: 'Current buy/sell NGN rates and order limits' })
  get(): RampRatesSnapshot {
    return this.rates.getSnapshot();
  }

  @Put()
  @RequireAnyPermission(Permission.WorkspaceWrite, Permission.WalletsAdjust)
  @ApiOperation({
    summary: 'Update buy/sell rates and limits (applies immediately to WhatsApp)',
  })
  async put(
    @Body() dto: UpdateRampRatesDto,
    @CurrentUser('userId') userId: string,
  ): Promise<RampRatesSnapshot> {
    return this.rates.update({
      ...dto,
      updatedByUserId: userId,
    });
  }
}
