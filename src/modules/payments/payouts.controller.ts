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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserType, type PayoutStatus } from '@prisma/client';

import {
  buildCursorPage,
  CursorPaginationQueryDto,
  type CursorPage,
} from '../../core/dto/pagination.dto';
import { Money } from '../../core/money/money';
import { Cursor } from '../../core/utils/cursor.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import type { Request } from 'express';

import { deviceFrom } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import { CreatePayoutDto, ResolveAccountQueryDto } from './dto/payout.dto';
import { PayoutService } from './payout.service';

interface BankResponse {
  name: string;
  code: string;
}

interface ResolvedAccountResponse {
  accountNumber: string;
  bankCode: string;
  accountName: string;
}

interface PayoutResponse {
  reference: string;
  status: PayoutStatus;
  amount: ReturnType<Money['toJSON']>;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration: string | null;
  /** FalconPay's transaction reference — quote this to support. */
  providerReference: string | null;
  failureReason: string | null;
  requestedAt: string;
  completedAt: string | null;
}

/**
 * Customer-facing withdrawals.
 *
 * Every route resolves the wallet from the **authenticated principal**, never
 * from a path parameter, for the same reason as {@link WalletController}: an
 * identifier in the URL is an invitation to enumerate, and tenant scoping would
 * not stop one customer reading another's within the same tenant.
 *
 * `GET /payouts/:reference` is safe because the lookup is scoped by `userId` as
 * well as reference — the reference in the path narrows, it does not authorise.
 */
@ApiTags('Payouts')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
@Controller({ path: 'payouts', version: '1' })
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutService,
    private readonly auth: AuthService,
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
  ) {}

  @Get('banks')
  @ApiOperation({
    summary: 'Banks that can receive a transfer',
    description: 'Cached for an hour. Use `code` for every subsequent call.',
  })
  async banks(): Promise<BankResponse[]> {
    return this.payouts.listBanks();
  }

  @Get('resolve-account')
  @ApiOperation({
    summary: 'Resolve a NUBAN to its account name',
    description:
      'Call this before creating a payout and show the name to the customer for confirmation. ' +
      'Bank transfers are not reversible, so a confirmed name is the only protection against a typo.',
  })
  async resolveAccount(@Query() query: ResolveAccountQueryDto): Promise<ResolvedAccountResponse> {
    return this.payouts.resolveAccount(query.accountNumber, query.bankCode);
  }

  @Post()
  // 202, not 201: the provider has accepted the instruction, nobody has been
  // paid yet. The status arrives on a webhook, and a client that reads this as
  // "sent" will tell the customer something untrue.
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Withdraw to a bank account',
    description:
      'Holds the funds and submits the transfer. A 202 means accepted, **not** completed — poll ' +
      '`GET /payouts/{reference}` or wait for the terminal status. Pass `Idempotency-Key` (or ' +
      '`idempotencyKey` in the body) so a retried submission does not send twice.',
  })
  async create(
    @CurrentUser('userId') userId: string,
    @Body() body: CreatePayoutDto,
    @Req() request: Request,
    @Headers('idempotency-key') headerKey?: string,
  ): Promise<PayoutResponse> {
    // Money leaves the platform: confirm it's really the customer, with lockout on guessing.
    await this.auth.verifyTransactionPin(userId, body.pin, deviceFrom(request));

    const payout = await this.payouts.requestPayout({
      userId,
      // A decimal string all the way in — the amount never exists as a float.
      amount: Money.fromNaira(body.amount),
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
      narration: body.narration,
      // The body wins over the header only because a client that sent both meant
      // the explicit one; either alone is equally acceptable.
      idempotencyKey: body.idempotencyKey ?? headerKey,
    });

    return toResponse(payout);
  }

  @Get(':reference')
  @ApiOperation({
    summary: 'A single withdrawal',
    description: 'Scoped to the authenticated customer; another customer’s reference returns 404.',
  })
  async findOne(
    @CurrentUser('userId') userId: string,
    @Param('reference') reference: string,
  ): Promise<PayoutResponse | null> {
    const payout = await this.db.payout.findFirst({ where: { userId, reference } });
    return payout ? toResponse(payout) : null;
  }

  @Get()
  @ApiOperation({ summary: 'Withdrawal history, newest first' })
  async list(
    @CurrentUser('userId') userId: string,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<CursorPage<PayoutResponse>> {
    const cursor = query.cursor ? Cursor.toDate(query.cursor) : undefined;

    const rows = await this.db.payout.findMany({
      where: {
        userId,
        // Keyset predicate: everything strictly older than the last row seen.
        // `(createdAt, id)` together, because timestamps collide and a plain
        // `createdAt <` would skip rows sharing a millisecond.
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.date } },
                { createdAt: cursor.date, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row is how `hasNextPage` is known without a second COUNT.
      take: query.limit + 1,
    });

    const page = buildCursorPage(rows, query.limit, (row) =>
      Cursor.fromDate(row.createdAt, row.id),
    );

    return { items: page.items.map(toResponse), meta: page.meta };
  }
}

/**
 * The API shape of a payout.
 *
 * `metadata` and the internal ids are deliberately absent: the raw provider
 * payload is support material, not something a customer's client needs, and
 * exposing `ledgerEntryId` invites clients to build on internal identifiers.
 */
function toResponse(payout: {
  reference: string;
  status: PayoutStatus;
  amount: bigint;
  currency: string;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration: string | null;
  providerReference: string | null;
  failureReason: string | null;
  requestedAt: Date;
  completedAt: Date | null;
}): PayoutResponse {
  return {
    reference: payout.reference,
    status: payout.status,
    amount: Money.fromKobo(payout.amount, payout.currency).toJSON(),
    bankName: payout.bankName,
    bankCode: payout.bankCode,
    accountNumber: payout.accountNumber,
    accountName: payout.accountName,
    narration: payout.narration,
    providerReference: payout.providerReference,
    failureReason: payout.failureReason,
    requestedAt: payout.requestedAt.toISOString(),
    completedAt: payout.completedAt?.toISOString() ?? null,
  };
}
