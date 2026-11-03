import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ConversationStatus,
  InvitationStatus,
  MessageDirection,
  UserStatus,
  UserType,
  WebhookEventStatus,
} from '@prisma/client';

import { Permission } from '../../../core/authorization/permission.enum';
import { Money } from '../../../core/money/money';
import { InjectPrisma } from '../../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../../infrastructure/database/prisma.service';
import { RequireUserType } from '../../auth/decorators/user-type.decorator';
import { RequireAnyPermission } from '../access/require-permissions.decorator';

interface DashboardSummary {
  customers: { total: number; active: number; suspended: number };
  members: { total: number; pendingInvitations: number };
  messaging: {
    conversationsOpen: number;
    inboundLast24h: number;
    outboundLast24h: number;
    failedLast24h: number;
    numbersConnected: number;
  };
  money: {
    totalBalance: ReturnType<Money['toJSON']>;
    walletsActive: number;
    /** Actual turnover (bank sends + bills), not wallet float. */
    volume: {
      ngnMoved24h: number;
      usdcMoved24h: number;
      ngnMovedAllTime: number;
      usdcMovedAllTime: number;
      bankSendNgn24h: number;
      billsNgn24h: number;
      airtimeNgn24h: number;
      billsCount24h: number;
      bankSendCount24h: number;
    };
  };
  health: { failedWebhooksLast24h: number };
  generatedAt: string;
}

/**
 * Count any bank send where crypto left (or payout is live). Skip only
 * pre-debit drafts and explicit cancels/refunds — otherwise the dashboard
 * stays at ₦0 while Activity shows large withdrawals.
 */
const VOLUME_SKIP_BANK = ['awaiting_crypto', 'cancelled', 'expired', 'refunded'] as const;
const VOLUME_OK_BILL = ['completed', 'submitted', 'processing', 'success', 'paid'] as const;

/**
 * The admin panel's home screen.
 *
 * One endpoint rather than a tile-per-request: the dashboard would otherwise
 * fire a dozen round trips on every load, and the counts must agree with each
 * other — tiles fetched seconds apart show a workspace that never existed.
 */
@ApiTags('Admin · Dashboard')
@ApiBearerAuth('access-token')
@RequireUserType(UserType.ADMIN)
@Controller({ path: 'admin/dashboard', version: '1' })
export class DashboardController {
  constructor(@InjectPrisma() private readonly db: ExtendedPrismaClient) {}

  @Get()
  @RequireAnyPermission(
    Permission.AnalyticsRead,
    Permission.CustomersRead,
    Permission.ConversationsRead,
    Permission.MembersRead,
  )
  @ApiOperation({ summary: 'Headline counts for the admin home screen' })
  async summary(): Promise<DashboardSummary> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      customersTotal,
      customersActive,
      customersSuspended,
      membersTotal,
      pendingInvitations,
      conversationsOpen,
      inboundLast24h,
      outboundLast24h,
      failedLast24h,
      numbersConnected,
      walletTotals,
      walletsActive,
      failedWebhooks,
      bankSend24h,
      bankSendAll,
      bills24h,
      billsAll,
      airtime24h,
    ] = await Promise.all([
      this.db.user.count({ where: { type: UserType.CUSTOMER, deletedAt: null } }),
      this.db.user.count({
        where: { type: UserType.CUSTOMER, deletedAt: null, status: UserStatus.ACTIVE },
      }),
      this.db.user.count({
        where: { type: UserType.CUSTOMER, deletedAt: null, status: UserStatus.SUSPENDED },
      }),
      this.db.membership.count({ where: { deletedAt: null } }),
      this.db.invitation.count({ where: { status: InvitationStatus.PENDING } }),
      this.db.conversation.count({ where: { status: ConversationStatus.OPEN } }),
      this.db.message.count({
        where: { direction: MessageDirection.INBOUND, createdAt: { gte: since } },
      }),
      this.db.message.count({
        where: { direction: MessageDirection.OUTBOUND, createdAt: { gte: since } },
      }),
      this.db.message.count({ where: { failedAt: { gte: since } } }),
      this.db.whatsAppPhoneNumber.count({ where: { status: 'CONNECTED' } }),
      this.db.wallet.aggregate({ _sum: { balance: true }, where: { deletedAt: null } }),
      this.db.wallet.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
      this.db.webhookEvent.count({
        where: { status: WebhookEventStatus.FAILED, createdAt: { gte: since } },
      }),
      this.db.zyRampBankSend.aggregate({
        where: { createdAt: { gte: since }, status: { notIn: [...VOLUME_SKIP_BANK] } },
        _sum: { amountNgn: true, amountUsdc: true },
        _count: true,
      }),
      this.db.zyRampBankSend.aggregate({
        where: { status: { notIn: [...VOLUME_SKIP_BANK] } },
        _sum: { amountNgn: true, amountUsdc: true },
      }),
      this.db.zyRampBillPurchase.aggregate({
        where: { createdAt: { gte: since }, status: { in: [...VOLUME_OK_BILL] } },
        _sum: { amountNgn: true, amountUsdc: true },
        _count: true,
      }),
      this.db.zyRampBillPurchase.aggregate({
        where: { status: { in: [...VOLUME_OK_BILL] } },
        _sum: { amountNgn: true, amountUsdc: true },
      }),
      this.db.zyRampBillPurchase.aggregate({
        where: {
          createdAt: { gte: since },
          vertical: 'airtime',
          status: { in: [...VOLUME_OK_BILL] },
        },
        _sum: { amountNgn: true },
      }),
    ]);

    const bankNgn24 = bankSend24h._sum.amountNgn ?? 0;
    const billsNgn24 = bills24h._sum.amountNgn ?? 0;
    const bankUsdc24 = Number(bankSend24h._sum.amountUsdc ?? 0);
    const billsUsdc24 = Number(bills24h._sum.amountUsdc ?? 0);
    const bankNgnAll = bankSendAll._sum.amountNgn ?? 0;
    const billsNgnAll = billsAll._sum.amountNgn ?? 0;
    const bankUsdcAll = Number(bankSendAll._sum.amountUsdc ?? 0);
    const billsUsdcAll = Number(billsAll._sum.amountUsdc ?? 0);

    return {
      customers: {
        total: customersTotal,
        active: customersActive,
        suspended: customersSuspended,
      },
      members: { total: membersTotal, pendingInvitations },
      messaging: {
        conversationsOpen,
        inboundLast24h,
        outboundLast24h,
        failedLast24h,
        numbersConnected,
      },
      money: {
        totalBalance: Money.fromKobo(walletTotals._sum.balance ?? 0n).toJSON(),
        walletsActive,
        volume: {
          ngnMoved24h: bankNgn24 + billsNgn24,
          usdcMoved24h: Number((bankUsdc24 + billsUsdc24).toFixed(6)),
          ngnMovedAllTime: bankNgnAll + billsNgnAll,
          usdcMovedAllTime: Number((bankUsdcAll + billsUsdcAll).toFixed(6)),
          bankSendNgn24h: bankNgn24,
          billsNgn24h: billsNgn24,
          airtimeNgn24h: airtime24h._sum.amountNgn ?? 0,
          billsCount24h: bills24h._count,
          bankSendCount24h: bankSend24h._count,
        },
      },
      health: { failedWebhooksLast24h: failedWebhooks },
      generatedAt: new Date().toISOString(),
    };
  }
}
