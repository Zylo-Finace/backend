import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UserType } from '@prisma/client';

import { Permission } from '../../../core/authorization/permission.enum';
import { Money } from '../../../core/money/money';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequireAnyPermission } from '../access/require-permissions.decorator';

export type AdminTransactionRow = {
  id: string;
  type: string;
  status: string;
  amountNgn?: number;
  amountUsdc?: number;
  network?: string;
  counterparty?: string;
  narration?: string | null;
  reference?: string | null;
  provider?: string | null;
  userId?: string;
  createdAt: string;
};

/**
 * Global audit feed for the admin Transactions screen.
 *
 * Unions NGN ledger rows, WhatsApp bank sends, and WhatsApp bill purchases
 * (airtime / data / electricity / cable / betting).
 */
@ApiTags('Admin · Transactions')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@Controller({ path: 'admin/transactions', version: '1' })
export class TransactionsController {
  constructor(@InjectPrisma() private readonly db: ExtendedPrismaClient) {}

  @Get()
  @RequireAnyPermission(Permission.WalletsRead, Permission.AnalyticsRead, Permission.CustomersRead)
  @ApiOperation({ summary: 'Recent transactions across all customers' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query('limit') limitRaw?: string): Promise<{ items: AdminTransactionRow[] }> {
    const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), 500);
    const take = Math.min(limit, 150);

    const [ledgerRows, bankSends, billPurchases] = await Promise.all([
      this.db.walletLedgerEntry.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          userId: true,
          direction: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          narration: true,
          reference: true,
          providerReference: true,
          createdAt: true,
        },
      }),
      this.db.zyRampBankSend.findMany({
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.db.zyRampBillPurchase.findMany({
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    const userIds = [...new Set(ledgerRows.map((r) => r.userId))];
    const users = userIds.length
      ? await this.db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true, username: true, phoneE164: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const ledgerItems: AdminTransactionRow[] = ledgerRows.map((row) => {
      const user = userById.get(row.userId);
      const who =
        user?.fullName ||
        (user?.username ? `@${user.username}` : null) ||
        user?.phoneE164 ||
        row.userId;
      return {
        id: `ledger:${row.id}`,
        type: mapLedgerType(row.type, row.direction),
        status: mapLedgerStatus(row.status),
        amountNgn: Number(Money.fromKobo(row.amount, row.currency).toJSON().amount),
        counterparty: row.narration || who,
        narration: row.narration,
        reference: row.reference,
        provider: row.providerReference ? 'ledger' : null,
        userId: row.userId,
        createdAt: row.createdAt.toISOString(),
      };
    });

    const ledgerRefs = new Set(
      ledgerItems.map((i) => (i.reference || '').toLowerCase()).filter(Boolean),
    );

    const bankItems: AdminTransactionRow[] = bankSends
      .filter((row) => !ledgerRefs.has(row.ref.toLowerCase()))
      .map((row) => ({
        id: `bank:${row.id}`,
        type: 'bank_send',
        status: mapBankSendStatus(row.status),
        amountNgn: row.amountNgn,
        amountUsdc: Number(row.amountUsdc),
        network: row.chain === 'celo' ? 'celo' : 'stellar',
        counterparty: `${row.bankName} · ${row.accountNumber}`,
        narration: row.accountName,
        reference: row.ref,
        provider: row.providerReference ? 'falconpay' : 'whatsapp',
        userId: row.platformUserId || undefined,
        createdAt: row.createdAt.toISOString(),
      }));

    const billItems: AdminTransactionRow[] = billPurchases.map((row) => ({
      id: `bill:${row.id}`,
      type: mapBillVertical(row.vertical),
      status: mapBillStatus(row.status),
      amountNgn: row.amountNgn,
      amountUsdc: Number(row.amountUsdc),
      network: row.chain === 'celo' ? 'celo' : 'stellar',
      counterparty: [row.productLabel, row.customerId, row.customerName, row.phone]
        .filter(Boolean)
        .join(' · '),
      narration: row.productLabel,
      reference: row.ref,
      provider: row.providerReference ? 'bills' : 'whatsapp',
      createdAt: row.createdAt.toISOString(),
    }));

    const items = [...ledgerItems, ...bankItems, ...billItems]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return { items };
  }
}

function mapBillVertical(vertical: string): string {
  const v = vertical.toLowerCase();
  if (v === 'airtime') return 'airtime';
  if (v === 'data') return 'data';
  if (v === 'electricity') return 'electricity';
  if (v === 'cable' || v === 'cable_tv' || v === 'tv') return 'cable';
  if (v === 'betting') return 'betting';
  return 'bills';
}

function mapBillStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'paid' || s === 'success') return 'success';
  if (s === 'failed' || s === 'cancelled') return 'failed';
  if (s === 'submitted' || s === 'processing') return 'processing';
  return 'pending';
}

function mapLedgerType(type: string, direction: string): string {
  const t = type.toLowerCase();
  if (t.includes('payout') || t.includes('withdraw')) return 'bank_send';
  if (t.includes('fund') || t.includes('deposit') || direction === 'CREDIT') return 'deposit';
  if (t.includes('refund')) return 'refund';
  if (t.includes('airtime') || t === 'purchase') return 'airtime';
  if (t.includes('data')) return 'data';
  if (t.includes('sell')) return 'sell';
  if (t.includes('buy')) return 'buy';
  if (t.includes('send') || t.includes('transfer')) return 'send';
  return 'bank_send';
}

function mapLedgerStatus(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('fail') || s.includes('cancel')) return 'failed';
  if (s.includes('success') || s.includes('complete') || s.includes('posted') || s === 'settled') {
    return 'success';
  }
  if (s.includes('process') || s.includes('await') || s.includes('hold')) return 'processing';
  if (s.includes('revers')) return 'reversed';
  return 'pending';
}

function mapBankSendStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === 'paid' || s === 'completed' || s === 'success') return 'success';
  if (s.includes('fail') || s === 'cancelled' || s === 'refunded') return 'failed';
  if (s === 'processing' || s === 'submitted' || s === 'crypto_sent') return 'processing';
  return 'pending';
}
