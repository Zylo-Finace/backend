import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import type { Request } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import {
  RewardsService,
  type ReferralView,
  type RewardHistoryItem,
  type RewardsSummary,
} from './rewards.service';

export class ApplyReferralCodeDto {
  @ApiProperty({ example: 'ADA7K2QF' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : value,
  )
  @Matches(/^[A-Z0-9]{4,16}$/, { message: 'Enter a valid referral code' })
  code!: string;
}

/** BANJEE Points: balance, streak, milestones and referrals for the signed-in customer. */
@ApiTags('Rewards')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
@Controller({ path: 'rewards', version: '1' })
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get()
  @ApiOperation({
    summary: 'Points balance, streak, milestones and referral stats',
    description: "Also records today's check-in and pays any milestones already reached.",
  })
  summary(@CurrentUser('userId') userId: string): Promise<RewardsSummary> {
    return this.rewards.getSummary(userId);
  }

  @Get('history')
  @ApiOperation({ summary: 'Points ledger, newest first' })
  history(
    @CurrentUser('userId') userId: string,
    @Query('limit') limit?: string,
  ): Promise<RewardHistoryItem[]> {
    return this.rewards.getHistory(userId, limit ? Number(limit) || 50 : 50);
  }

  @Get('referrals')
  @ApiOperation({ summary: 'People who joined with your code' })
  referrals(@CurrentUser('userId') userId: string): Promise<ReferralView[]> {
    return this.rewards.getReferrals(userId);
  }

  @Post('referral-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Add a friend's referral code after signing up",
    description: 'Allowed once, within 7 days of creating the account.',
  })
  applyCode(
    @CurrentUser('userId') userId: string,
    @Body() dto: ApplyReferralCodeDto,
    @Req() req: Request,
  ): Promise<RewardsSummary> {
    return this.rewards.applyCode(userId, dto.code, req.ip);
  }
}
