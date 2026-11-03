import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import type { Response } from 'express';

import { Public } from '../../core/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import {
  RampPortalService,
  type PortalActivityItem,
  type PortalCryptoWallet,
  type PortalPayoutAccount,
  type PortalRampProfile,
} from './ramp-portal.service';

@ApiTags('Ramp portal')
@Controller({ path: 'ramp-portal', version: '1' })
export class RampPortalController {
  constructor(private readonly portal: RampPortalService) {}

  @Get('wallets')
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
  @ApiOperation({
    summary: 'Custodial crypto wallets from WhatsApp (Stellar / Celo)',
  })
  async wallets(@CurrentUser('userId') userId: string): Promise<PortalCryptoWallet[]> {
    return this.portal.getCryptoWallets(userId);
  }

  @Get('profile')
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
  @ApiOperation({ summary: 'WhatsApp ramp profile linked to this phone' })
  async profile(@CurrentUser('userId') userId: string): Promise<PortalRampProfile> {
    return this.portal.getProfile(userId);
  }

  @Get('payout-accounts')
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
  @ApiOperation({
    summary: 'Saved NGN payout banks from WhatsApp (sell destinations)',
  })
  async payoutAccounts(@CurrentUser('userId') userId: string): Promise<PortalPayoutAccount[]> {
    return this.portal.getPayoutAccounts(userId);
  }

  @Get('activity')
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
  @ApiOperation({
    summary: 'Unified activity: NGN ledger + on-chain Stellar/Celo USDC transfers',
  })
  @ApiQuery({ name: 'limit', required: false })
  async activity(
    @CurrentUser('userId') userId: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: PortalActivityItem[]; total: number }> {
    const n = limit ? Number(limit) : 50;
    return this.portal.getActivity(userId, { limit: Number.isFinite(n) ? n : 50 });
  }

  @Get('statement')
  @ApiBearerAuth('access-token')
  @RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
  @ApiOperation({ summary: 'Generate own account statement (CSV / PDF / JSON)' })
  @ApiQuery({ name: 'from', required: true, description: 'ISO date YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: true })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'pdf', 'json'] })
  async statement(
    @CurrentUser('userId') userId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: 'csv' | 'pdf' | 'json' = 'csv',
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | Record<string, unknown>> {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return { error: 'Invalid from/to dates' };
    }
    const result = await this.portal.buildStatement(userId, {
      from: fromDate,
      to: toDate,
      format: format === 'pdf' || format === 'json' ? format : 'csv',
    });
    if (format === 'json') {
      return JSON.parse(String(result.body)) as Record<string, unknown>;
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    const buf = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, 'utf8');
    return new StreamableFile(buf);
  }

  @Get('rates')
  @Public()
  @ApiOperation({ summary: 'Buy/sell NGN rates used in WhatsApp' })
  rates() {
    return this.portal.getRates();
  }
}
