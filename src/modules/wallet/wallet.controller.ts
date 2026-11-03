import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';

import {
  buildCursorPage,
  CursorPaginationQueryDto,
  type CursorPage,
} from '../../core/dto/pagination.dto';
import { Cursor } from '../../core/utils/cursor.util';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireUserType } from '../auth/decorators/user-type.decorator';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { Money } from '../../core/money/money';
import { WalletService } from './wallet.service';

interface BalanceResponse {
  balance: ReturnType<Money['toJSON']>;
  available: ReturnType<Money['toJSON']>;
  locked: ReturnType<Money['toJSON']>;
  currency: string;
  status: string;
}

interface StatementEntry {
  id: string;
  direction: string;
  type: string;
  status: string;
  amount: ReturnType<Money['toJSON']>;
  balanceAfter: ReturnType<Money['toJSON']>;
  narration: string | null;
  reference: string;
  createdAt: string;
}

interface FundingAccountResponse {
  bankName: string;
  bankCode: string;
  accountName: string;
  accountNumber: string;
  currency: string;
  isActive: boolean;
}

/**
 * Customer-facing wallet endpoints.
 *
 * Every route resolves the wallet from the **authenticated principal**, never
 * from a path parameter. There is deliberately no `GET /wallets/:id`: an
 * identifier in the URL is an invitation to enumerate, and the tenant extension
 * — while it would stop cross-*tenant* access — would happily serve another
 * customer's wallet within the same tenant.
 */
@ApiTags('Wallet')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.CUSTOMER, UserType.ADMIN)
@Controller({ path: 'wallet', version: '1' })
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
  ) {}

  @Get('balance')
  @ApiOperation({
    summary: 'Current wallet balance',
    description:
      'Amounts are decimal strings, never JSON numbers — a float would lose precision on large balances.',
  })
  async balance(@CurrentUser('userId') userId: string): Promise<BalanceResponse> {
    const result = await this.wallet.getBalance(userId);

    return {
      balance: result.balance.toJSON(),
      available: result.available.toJSON(),
      locked: result.locked.toJSON(),
      currency: result.currency,
      status: result.status,
    };
  }

  @Get('statement')
  @ApiOperation({
    summary: 'Wallet statement, newest first',
    description: 'Cursor-paginated. Pass `meta.nextCursor` back as `cursor`.',
  })
  async statement(
    @CurrentUser('userId') userId: string,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<CursorPage<StatementEntry>> {
    const cursor = query.cursor ? Cursor.toDate(query.cursor) : undefined;

    const rows = await this.db.walletLedgerEntry.findMany({
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
      select: {
        id: true,
        direction: true,
        type: true,
        status: true,
        amount: true,
        balanceAfter: true,
        currency: true,
        narration: true,
        reference: true,
        createdAt: true,
      },
    });

    const page = buildCursorPage(rows, query.limit, (row) =>
      Cursor.fromDate(row.createdAt, row.id),
    );

    // Mapped after paging, so the cursor is derived from the database row rather
    // than from the serialised shape.
    return {
      items: page.items.map((row) => ({
        id: row.id,
        direction: row.direction,
        type: row.type,
        status: row.status,
        amount: Money.fromKobo(row.amount, row.currency).toJSON(),
        balanceAfter: Money.fromKobo(row.balanceAfter, row.currency).toJSON(),
        narration: row.narration,
        reference: row.reference,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: page.meta,
    };
  }

  @Get('funding-account')
  @ApiOperation({
    summary: 'The dedicated bank account that funds this wallet',
    description: 'Returns 404 until the payment provider has finished issuing the account.',
  })
  async fundingAccount(
    @CurrentUser('userId') userId: string,
  ): Promise<FundingAccountResponse | null> {
    const account = await this.db.bankAccount.findFirst({
      where: { userId },
      select: {
        bankName: true,
        bankCode: true,
        accountName: true,
        accountNumber: true,
        currency: true,
        isActive: true,
      },
    });

    return account;
  }
}
