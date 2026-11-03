import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { Money } from '../../core/money/money';
import { Phone } from '../../core/utils/phone.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { getRampConfig } from './ramp.config';
import { RampCeloWalletService } from './ramp.celo-wallet';
import { RampNairaService } from './ramp.naira';
import { RampOnchainHistoryService } from './ramp.onchain-history';
import { buildSimplePdf, buildStatementCsv } from './ramp.statement-export';
import { formatSacAmount } from './ramp.stellar-classic';
import { RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStoreService } from './ramp.store';

export type PortalCryptoWallet = {
  id: string;
  type: 'stellar' | 'celo';
  address: string;
  nickname?: string;
  balanceUsdc: number;
  balanceUsdt?: number;
  balanceCusd?: number;
  balanceTotal?: number;
  balanceXlm?: number;
  status: 'active' | 'pending';
};

export type PortalRampProfile = {
  phone: string | null;
  username: string | null;
  whatsappName: string | null;
  email: string | null;
  stellarAddress: string | null;
  celoAddress: string | null;
  isOnboarded: boolean;
};

export type PortalPayoutAccount = {
  id: number;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  isDefault: boolean;
  createdAt: string;
};

export type PortalActivityItem = {
  id: string;
  source: 'ledger' | 'onchain' | 'bill';
  type: string;
  direction: string;
  status: string;
  amountUsdc?: number;
  amountNgn?: number;
  network?: 'stellar' | 'celo' | null;
  counterparty?: string | null;
  narration?: string | null;
  reference?: string | null;
  txHash?: string | null;
  txUrl?: string | null;
  createdAt: string;
  groupKey?: string | null;
};

@Injectable()
export class RampPortalService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly stellar: RampStellarWalletService,
    private readonly celo: RampCeloWalletService,
    private readonly onchain: RampOnchainHistoryService,
    private readonly store: RampStoreService,
    private readonly naira: RampNairaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampPortalService.name);
  }

  private phoneCandidates(phoneE164: string): string[] {
    const wa = Phone.toWhatsAppId(phoneE164);
    const local =
      phoneE164.startsWith('+234') && phoneE164.length >= 14 ? `0${phoneE164.slice(4)}` : undefined;
    return [...new Set([wa, phoneE164, `+${wa}`, local].filter(Boolean) as string[])];
  }

  private async findRampUser(phoneE164: string) {
    return this.db.zyRampUser.findFirst({
      where: { phone: { in: this.phoneCandidates(phoneE164) } },
    });
  }

  private async resolvePhoneE164(userId: string): Promise<string | null> {
    const user = await this.db.user.findFirst({
      where: { id: userId },
      select: { phoneE164: true },
    });
    return user?.phoneE164 ?? null;
  }

  async getProfile(userId: string): Promise<PortalRampProfile> {
    const phoneE164 = await this.resolvePhoneE164(userId);
    if (!phoneE164) {
      return {
        phone: null,
        username: null,
        whatsappName: null,
        email: null,
        stellarAddress: null,
        celoAddress: null,
        isOnboarded: false,
      };
    }
    const ramp = await this.findRampUser(phoneE164);
    return {
      phone: phoneE164,
      username: ramp?.username ?? null,
      whatsappName: ramp?.whatsappName ?? null,
      email: ramp?.email ?? null,
      stellarAddress: ramp?.zyloWallet ?? ramp?.stellarWallet ?? ramp?.wallet ?? null,
      celoAddress: ramp?.celoWallet ?? null,
      isOnboarded: Boolean(ramp?.onboardedAt && ramp?.username && ramp?.pinHash),
    };
  }

  /**
   * WhatsApp-saved NGN payout destinations (`zylo_ramp_payout_accounts`),
   * resolved via the platform user's phone (+ WA id variants).
   *
   * Legacy `ZyRampUser.bank*` rows (no bank code) are migrated into the payout
   * table when the bank name uniquely matches FalconPay's list. Fake `id: 0`
   * accounts are never returned — sell requires a real `payoutAccountId`.
   */
  async getPayoutAccounts(userId: string): Promise<PortalPayoutAccount[]> {
    const phoneE164 = await this.resolvePhoneE164(userId);
    if (!phoneE164) return [];

    const ramp = await this.findRampUser(phoneE164);
    const phones = [...this.phoneCandidates(phoneE164), ...(ramp?.phone ? [ramp.phone] : [])];

    let rows = await this.store.listPayoutAccountsForPhones(phones);

    if (rows.length === 0 && ramp?.bankAccount && ramp.bankName && ramp.accountName) {
      const acct = ramp.bankAccount.replace(/\D/g, '');
      const phone = ramp.phone || phones[0];
      if (phone && /^\d{10}$/.test(acct)) {
        try {
          const bank = await this.naira.resolveSupportedBank('', ramp.bankName);
          await this.store.upsertPayoutAccount({
            phone,
            bankCode: bank.code,
            bankName: bank.name,
            accountNumber: acct,
            accountName: ramp.accountName,
            makeDefault: true,
          });
          rows = await this.store.listPayoutAccountsForPhones(phones);
        } catch (e) {
          this.logger.warn(
            {
              err: e instanceof Error ? e.message : String(e),
              bankName: ramp.bankName,
              phone,
            },
            '[ramp-portal] legacy payout bank could not be migrated — user must re-save via Send',
          );
        }
      }
    }

    return rows
      .filter((r) => Boolean(r.bankCode) && r.id > 0)
      .map((r) => ({
        id: r.id,
        bankName: r.bankName,
        bankCode: r.bankCode,
        accountNumber: r.accountNumber,
        accountName: r.accountName,
        isDefault: r.isDefault,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  async getCryptoWallets(userId: string): Promise<PortalCryptoWallet[]> {
    const phoneE164 = await this.resolvePhoneE164(userId);
    if (!phoneE164) return [];

    const ramp = await this.findRampUser(phoneE164);
    if (!ramp) {
      this.logger.debug({ userId }, 'No ZyRampUser linked for portal wallet read');
      return [];
    }

    const wallets: PortalCryptoWallet[] = [];
    const stellarAddr = ramp.zyloWallet || ramp.stellarWallet || ramp.wallet;

    if (stellarAddr && /^[GC][A-Z0-9]{55}$/i.test(stellarAddr)) {
      try {
        const bal = await this.stellar.getBalances(stellarAddr);
        wallets.push({
          id: `stellar:${stellarAddr}`,
          type: 'stellar',
          address: stellarAddr,
          nickname: 'Stellar (WhatsApp)',
          balanceUsdc: Number(formatSacAmount(bal.usdc)),
          balanceTotal: Number(formatSacAmount(bal.usdc)),
          balanceXlm: Number(formatSacAmount(bal.xlm)),
          status: 'active',
        });
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err), stellarAddr },
          '[ramp-portal] Stellar balance failed',
        );
        wallets.push({
          id: `stellar:${stellarAddr}`,
          type: 'stellar',
          address: stellarAddr,
          nickname: 'Stellar (WhatsApp)',
          balanceUsdc: 0,
          balanceTotal: 0,
          balanceXlm: 0,
          status: 'active',
        });
      }
    }

    if (ramp.celoWallet && /^0x[a-fA-F0-9]{40}$/.test(ramp.celoWallet)) {
      try {
        const bal = await this.celo.getStableBalances(ramp.celoWallet);
        wallets.push({
          id: `celo:${ramp.celoWallet}`,
          type: 'celo',
          address: ramp.celoWallet,
          nickname: 'Celo (WhatsApp)',
          balanceUsdc: bal.usdc,
          balanceUsdt: bal.usdt,
          balanceCusd: bal.cusd,
          balanceTotal: bal.total,
          status: 'active',
        });
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          '[ramp-portal] Celo balance failed',
        );
        wallets.push({
          id: `celo:${ramp.celoWallet}`,
          type: 'celo',
          address: ramp.celoWallet,
          nickname: 'Celo (WhatsApp)',
          balanceUsdc: 0,
          balanceUsdt: 0,
          balanceCusd: 0,
          balanceTotal: 0,
          status: 'active',
        });
      }
    }

    return wallets;
  }

  getRates() {
    const config = getRampConfig();
    return {
      sellRateNgn: config.rates.sellNgn,
      buyRateNgn: config.rates.buyNgn,
      maxOrderUsdc: config.maxOrderUsdc,
      minBankSendNgn: config.minBankSendNgn,
      maxBankSendNgn: config.maxBankSendNgn,
      sellFeeNgn: config.sellFeeNgn,
      timestamp: new Date().toISOString(),
      source: 'whatsapp-ramp',
    };
  }

  private async resolveCounterpartyLabel(addr: string): Promise<string> {
    if (!addr || addr === 'unknown') return addr;
    try {
      if (/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        const peer = await this.store.findUserByCeloWallet(addr);
        if (peer?.username) return `@${peer.username}`;
      }
      if (/^[GC][A-Z0-9]{55}$/i.test(addr)) {
        const peer = await this.store.findUserByZyloWallet(addr);
        if (peer?.username) return `@${peer.username}`;
      }
    } catch {
      /* keep raw */
    }
    return addr;
  }

  private mapLedgerType(type: string, direction: string): string {
    const t = type.toLowerCase();
    if (t.includes('payout') || t.includes('withdraw')) return 'bank_send';
    if (t.includes('fund') || t.includes('deposit') || direction === 'CREDIT') return 'deposit';
    if (t.includes('refund')) return 'refund';
    if (t.includes('airtime')) return 'airtime';
    if (t.includes('data')) return 'data';
    if (t.includes('electric')) return 'electricity';
    if (t.includes('cable')) return 'cable';
    if (t.includes('betting')) return 'betting';
    return 'bank_send';
  }

  private mapLedgerStatus(status: string): string {
    const s = status.toLowerCase();
    if (s.includes('fail') || s.includes('cancel')) return 'failed';
    if (s.includes('success') || s.includes('complete') || s.includes('posted') || s === 'settled')
      return 'success';
    if (s.includes('process') || s.includes('await') || s.includes('hold')) return 'processing';
    if (s.includes('revers')) return 'reversed';
    return 'pending';
  }

  async getActivity(
    userId: string,
    opts?: { limit?: number },
  ): Promise<{ items: PortalActivityItem[]; total: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const phoneE164 = await this.resolvePhoneE164(userId);
    const ramp = phoneE164 ? await this.findRampUser(phoneE164) : null;
    const stellarAddr = ramp?.zyloWallet || ramp?.stellarWallet || ramp?.wallet || null;
    const celoAddr = ramp?.celoWallet || null;

    const [ledgerRows, chain, billRows] = await Promise.all([
      this.db.walletLedgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          direction: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          narration: true,
          reference: true,
          createdAt: true,
        },
      }),
      this.onchain.listForWallets({
        stellarAddress: stellarAddr,
        celoAddress: celoAddr,
        limit,
      }),
      ramp
        ? this.db.zyRampBillPurchase.findMany({
            where: { phone: ramp.phone },
            orderBy: { createdAt: 'desc' },
            take: limit,
          })
        : Promise.resolve([]),
    ]);

    // Airtime, data, electricity, TV and betting — the purchase record, which
    // carries what was bought. Its crypto debit is folded in rather than listed
    // separately as an anonymous "USDC sent" to the vault.
    const billItems: PortalActivityItem[] = billRows.map((row) => {
      const txHash = row.stellarTxHash || row.celoTxHash || null;
      const onchainTx = txHash
        ? chain.find((c) => c.txHash.toLowerCase() === txHash.toLowerCase())
        : undefined;
      const who = [row.customerName, row.customerId].filter(Boolean).join(' · ');
      return {
        id: `bill:${row.id}`,
        source: 'bill' as const,
        type: row.vertical,
        direction: 'out',
        status: this.mapLedgerStatus(row.status === 'submitted' ? 'processing' : row.status),
        amountNgn: row.amountNgn,
        amountUsdc: Number(row.amountUsdc),
        network: row.chain === 'celo' ? 'celo' : 'stellar',
        counterparty: row.productLabel ?? row.vertical,
        narration: [row.productLabel, who].filter(Boolean).join(' — '),
        reference: row.ref,
        groupKey: row.ref,
        txHash,
        txUrl: onchainTx?.txUrl ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });
    const billHashes = new Set(
      billItems.map((b) => b.txHash?.toLowerCase()).filter((h): h is string => Boolean(h)),
    );

    const ledgerItems: PortalActivityItem[] = ledgerRows.map((row) => {
      const ngn = Number(Money.fromKobo(row.amount, row.currency).toJSON().amount);
      const ref = row.reference;
      return {
        id: `ledger:${row.id}`,
        source: 'ledger' as const,
        type: this.mapLedgerType(row.type, row.direction),
        direction: row.direction === 'CREDIT' ? 'in' : 'out',
        status: this.mapLedgerStatus(row.status),
        amountNgn: ngn,
        counterparty: row.narration ?? ref,
        narration: row.narration,
        reference: ref,
        groupKey: ref?.replace(/_(?:credit|debit|fund|payout|delivery)$/i, '') ?? ref,
        createdAt: row.createdAt.toISOString(),
      };
    });

    const ledgerBlob = ledgerItems
      .map((i) => `${i.narration ?? ''} ${i.reference ?? ''}`)
      .join(' ')
      .toLowerCase();

    const chainItems: PortalActivityItem[] = [];
    for (const tx of chain) {
      const label = await this.resolveCounterpartyLabel(tx.counterparty);
      const linked = ledgerBlob.includes(tx.txHash.toLowerCase().slice(0, 10));
      const isExternalIn = tx.direction === 'in' && !linked;
      chainItems.push({
        id: tx.id,
        source: 'onchain',
        type: tx.direction === 'in' ? 'deposit' : 'send',
        direction: tx.direction,
        status: tx.status,
        amountUsdc: tx.amountUsdc,
        network: tx.network,
        counterparty: isExternalIn ? `External deposit · ${label}` : label,
        narration: `${tx.direction === 'in' ? 'Received' : 'Sent'} ${tx.amountUsdc} ${tx.asset} (${tx.network})`,
        reference: linked ? undefined : `onchain:${tx.txHash}`,
        groupKey: linked ? undefined : `onchain:${tx.txHash}`,
        txHash: tx.txHash,
        txUrl: tx.txUrl,
        createdAt: tx.createdAt,
      });
    }

    const enrichedLedger = ledgerItems.map((leg) => {
      const match = chain.find((c) => {
        const blob = `${leg.narration ?? ''} ${leg.reference ?? ''}`.toLowerCase();
        return blob.includes(c.txHash.toLowerCase().slice(0, 10));
      });
      if (!match) return leg;
      return {
        ...leg,
        network: match.network,
        txHash: match.txHash,
        txUrl: match.txUrl,
        amountUsdc: leg.amountUsdc ?? match.amountUsdc,
        groupKey: leg.groupKey ?? match.txHash,
      };
    });

    const linkedHashes = new Set(
      enrichedLedger.filter((l) => l.txHash).map((l) => l.txHash!.toLowerCase()),
    );
    const standaloneChain = chainItems.filter(
      (c) =>
        !c.txHash ||
        (!linkedHashes.has(c.txHash.toLowerCase()) && !billHashes.has(c.txHash.toLowerCase())),
    );

    const items = [...enrichedLedger, ...billItems, ...standaloneChain]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return { items, total: items.length };
  }

  async getReconciliation(userId: string) {
    const wallets = await this.getCryptoWallets(userId);
    const stellar = wallets.find((w) => w.type === 'stellar');
    const celo = wallets.find((w) => w.type === 'celo');
    const wallet = await this.db.wallet.findFirst({
      where: { userId },
      select: { balance: true, lockedBalance: true, currency: true },
    });
    const balance = wallet
      ? Number(Money.fromKobo(wallet.balance, wallet.currency).toJSON().amount)
      : 0;
    const locked = wallet
      ? Number(Money.fromKobo(wallet.lockedBalance, wallet.currency).toJSON().amount)
      : 0;

    const flags: string[] = [];
    if (!stellar && !celo) flags.push('No custodial crypto wallet linked to this phone');
    if (wallet && balance < 0) flags.push('NGN ledger balance is negative');

    return {
      onchain: {
        stellarUsdc: stellar?.balanceUsdc ?? 0,
        celoTotal: celo?.balanceTotal ?? 0,
      },
      ledgerNgn: {
        balance,
        available: balance - locked,
        locked,
      },
      flags,
    };
  }

  async buildStatement(
    userId: string,
    opts: { from: Date; to: Date; format: 'csv' | 'pdf' | 'json' },
  ) {
    const user = await this.db.user.findFirst({
      where: { id: userId },
      select: { id: true, fullName: true, username: true, phoneE164: true },
    });
    const activity = await this.getActivity(userId, { limit: 100 });
    const inRange = activity.items.filter((i) => {
      const t = new Date(i.createdAt).getTime();
      return t >= opts.from.getTime() && t <= opts.to.getTime();
    });

    const ledgerAsc = await this.db.walletLedgerEntry.findMany({
      where: {
        userId,
        createdAt: { gte: opts.from, lte: opts.to },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        narration: true,
        type: true,
        direction: true,
        amount: true,
        balanceAfter: true,
        currency: true,
        reference: true,
      },
    });

    let running: number | null = null;
    const rows: Array<{
      date: string;
      description: string;
      type: string;
      amount: number;
      balance_after: number;
    }> = ledgerAsc.map((row) => {
      const amount = Number(Money.fromKobo(row.amount, row.currency).toJSON().amount);
      const signed = row.direction === 'CREDIT' ? amount : -amount;
      running = Number(Money.fromKobo(row.balanceAfter, row.currency).toJSON().amount);
      return {
        date: row.createdAt.toISOString(),
        description: row.narration ?? row.reference,
        type: row.type,
        amount: signed,
        balance_after: running,
      };
    });

    for (const item of inRange.filter((i) => i.source === 'onchain' || i.source === 'bill')) {
      rows.push({
        date: item.createdAt,
        description: item.narration ?? item.counterparty ?? item.id,
        type: item.type,
        amount: item.direction === 'in' ? (item.amountUsdc ?? 0) : -(item.amountUsdc ?? 0),
        balance_after: running ?? 0,
      });
    }
    rows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const opening = rows.length ? Number(rows[0]!.balance_after) - Number(rows[0]!.amount) : null;
    const closing = rows.length ? Number(rows[rows.length - 1]!.balance_after) : null;
    const name = user?.fullName || user?.username || user?.phoneE164 || userId;
    const periodFrom = opts.from.toISOString().slice(0, 10);
    const periodTo = opts.to.toISOString().slice(0, 10);
    const meta = {
      userId,
      periodFrom,
      periodTo,
      openingBalanceNgn: opening,
      closingBalanceNgn: closing,
      rowCount: rows.length,
    };

    if (opts.format === 'json') {
      return {
        filename: `banjee-statement-${periodFrom}_${periodTo}.json`,
        contentType: 'application/json',
        body: JSON.stringify({ header: { name, ...meta }, rows }, null, 2) as string | Buffer,
        meta,
      };
    }

    if (opts.format === 'csv') {
      const csv = buildStatementCsv([
        {
          date: 'HEADER',
          description: `BANJEE statement · ${name} · ${userId}`,
          type: `${periodFrom} → ${periodTo}`,
          amount: opening ?? '',
          balance_after: closing ?? '',
        },
        ...rows,
      ]);
      return {
        filename: `banjee-statement-${periodFrom}_${periodTo}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: csv as string | Buffer,
        meta,
      };
    }

    const lines = [
      `Account: ${name}`,
      `User ID: ${userId}`,
      `Period: ${periodFrom} to ${periodTo}`,
      `Opening (NGN ledger): ${opening ?? '—'}`,
      `Closing (NGN ledger): ${closing ?? '—'}`,
      '',
      'Date | Description | Type | Amount | Balance',
      ...rows
        .slice(0, 45)
        .map(
          (r) =>
            `${r.date.slice(0, 10)} | ${String(r.description).slice(0, 40)} | ${r.type} | ${r.amount} | ${r.balance_after}`,
        ),
    ];
    const pdf = buildSimplePdf({ title: 'BANJEE Account Statement', lines });
    return {
      filename: `banjee-statement-${periodFrom}_${periodTo}.pdf`,
      contentType: 'application/pdf',
      body: pdf as string | Buffer,
      meta,
    };
  }

  async getActivityForAdmin(userId: string, limit = 100) {
    const [activity, reconciliation] = await Promise.all([
      this.getActivity(userId, { limit }),
      this.getReconciliation(userId),
    ]);
    return { items: activity.items, reconciliation };
  }
}
