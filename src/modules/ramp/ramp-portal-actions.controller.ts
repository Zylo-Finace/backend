import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';
import type { Request } from 'express';

import { deviceFrom } from '../auth/auth.controller';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import {
  AirtimeDto,
  BankSendDto,
  BankSendQuoteQueryDto,
  BettingDto,
  CableDto,
  CablePackagesQueryDto,
  DataDto,
  ElectricityDto,
  DataPlansQueryDto,
  ResolveRecipientQueryDto,
  SellUsdcDto,
  SendUsdcDto,
  VerifyBettingQueryDto,
  VerifyMeterQueryDto,
  VerifySmartCardQueryDto,
} from './dto/portal-actions.dto';
import { RampPortalActionsService } from './ramp-portal-actions.service';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description:
    'One key per reviewed transaction. Retrying with the same key never moves money twice.',
};

/**
 * Money movement from the web portal — the same fulfilment the WhatsApp chat
 * uses, confirmed with the customer's transfer PIN.
 */
@ApiTags('Ramp portal — actions')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
@Controller({ path: 'ramp-portal', version: '1' })
export class RampPortalActionsController {
  constructor(private readonly actions: RampPortalActionsService) {}

  @Get('recipients')
  @ApiOperation({ summary: 'Find who a USDC transfer will go to (username, contact or address)' })
  recipients(@CurrentUser('userId') userId: string, @Query() query: ResolveRecipientQueryDto) {
    return this.actions.resolveRecipients(userId, query.query, query.network);
  }

  @Post('transfers/usdc')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: 'Send USDC to a BANJEE user, saved contact or wallet address' })
  sendUsdc(
    @CurrentUser('userId') userId: string,
    @Body() dto: SendUsdcDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.sendUsdc(userId, dto, key, deviceFrom(req));
  }

  @Get('bank-sends/quote')
  @ApiOperation({ summary: 'USDC needed to send an amount of Naira to a bank' })
  bankSendQuote(@Query() query: BankSendQuoteQueryDto) {
    return this.actions.quoteBankSend(Number(query.amountNgn));
  }

  @Get('bank-sends/recent')
  @ApiOperation({
    summary: 'Recent bank sends / sells for the signed-in customer',
    description: 'Used to recover the reference when a confirm response was lost.',
  })
  recentBankSends(@CurrentUser('userId') userId: string) {
    return this.actions.listRecentBankSends(userId, 15);
  }

  @Post('bank-sends')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Send Naira to a bank account, paid from USDC',
    description:
      'The account name is resolved server-side. `status` is `processing` until the bank confirms — poll GET /ramp-portal/bank-sends/{ref}.',
  })
  bankSend(
    @CurrentUser('userId') userId: string,
    @Body() dto: BankSendDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.bankSend(userId, dto, key, deviceFrom(req));
  }

  @Get('bank-sends/:ref')
  @ApiOperation({ summary: 'Status of a bank send or sale (scoped to the caller)' })
  bankSendStatus(@CurrentUser('userId') userId: string, @Param('ref') ref: string) {
    return this.actions.getBankSend(userId, ref);
  }

  @Post('sells')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Sell USDC for Naira, paid to a saved bank account',
    description:
      'Refused with PRECONDITION_FAILED if the sell rate changed since the customer reviewed it.',
  })
  sell(
    @CurrentUser('userId') userId: string,
    @Body() dto: SellUsdcDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.sellUsdc(userId, dto, key, deviceFrom(req));
  }

  @Get('data-plans')
  @ApiOperation({ summary: 'Data plans for a mobile network, with prices' })
  dataPlans(@Query() query: DataPlansQueryDto) {
    return this.actions.listDataPlans(query.network);
  }

  @Post('airtime')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: 'Buy airtime, paid from USDC' })
  airtime(
    @CurrentUser('userId') userId: string,
    @Body() dto: AirtimeDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.buyAirtime(userId, dto, key, deviceFrom(req));
  }

  @Post('data')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: 'Buy a data plan, paid from USDC' })
  data(
    @CurrentUser('userId') userId: string,
    @Body() dto: DataDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.buyData(userId, dto, key, deviceFrom(req));
  }

  // ── Utility bills ──────────────────────────────────────────────────────────

  @Get('bills/electricity/discos')
  @ApiOperation({ summary: 'Electricity distribution companies, meter types and amount limits' })
  discos() {
    return this.actions.listDiscos();
  }

  @Get('bills/electricity/verify')
  @ApiOperation({ summary: 'Name registered to a meter number' })
  verifyMeter(@Query() query: VerifyMeterQueryDto) {
    return this.actions.verifyMeter(query.discoCode, query.meterType, query.meterNumber);
  }

  @Post('bills/electricity')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Buy an electricity token or pay a postpaid bill, paid from USDC',
    description:
      'The meter is verified server-side. `meterToken` is returned when the provider issues it at once.',
  })
  electricity(
    @CurrentUser('userId') userId: string,
    @Body() dto: ElectricityDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.payElectricity(userId, dto, key, deviceFrom(req));
  }

  @Get('bills/cable/packages')
  @ApiOperation({ summary: 'TV bouquets for a provider, with prices' })
  cablePackages(@Query() query: CablePackagesQueryDto) {
    return this.actions.listCablePackages(query.provider);
  }

  @Get('bills/cable/verify')
  @ApiOperation({ summary: 'Name registered to a smartcard / IUC number' })
  verifySmartCard(@Query() query: VerifySmartCardQueryDto) {
    return this.actions.verifySmartCard(query.provider, query.smartCardNumber);
  }

  @Post('bills/cable')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: 'Renew a TV subscription, paid from USDC' })
  cable(
    @CurrentUser('userId') userId: string,
    @Body() dto: CableDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.payCable(userId, dto, key, deviceFrom(req));
  }

  @Get('bills/betting/companies')
  @ApiOperation({ summary: 'Betting platforms that can be funded, with amount limits' })
  bettingCompanies() {
    return this.actions.listBettingCompanies();
  }

  @Get('bills/betting/verify')
  @ApiOperation({ summary: 'Name registered to a betting account ID' })
  verifyBetting(@Query() query: VerifyBettingQueryDto) {
    return this.actions.verifyBettingCustomer(query.companyCode, query.customerId);
  }

  @Post('bills/betting')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: 'Fund a betting wallet, paid from USDC' })
  betting(
    @CurrentUser('userId') userId: string,
    @Body() dto: BettingDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
  ) {
    return this.actions.fundBetting(userId, dto, key, deviceFrom(req));
  }
}
