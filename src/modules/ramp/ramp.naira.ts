import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { LedgerEntryType, PayoutStatus, Prisma, UserStatus, UserType } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { ActorType, RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { Phone } from '../../core/utils/phone.util';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PayoutService } from '../payments/payout.service';
import type { Bank, ResolvedAccount } from '../payments/payout-provider.interface';
import { WalletService } from '../wallet/wallet.service';
import { getRampConfig } from './ramp.config';
import { formatCeloStable, RampCeloWalletService } from './ramp.celo-wallet';
import { renderBankSendReceiptPng } from './ramp.receipt';
import { formatSacAmount, RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStoreService } from './ramp.store';
import { RampWhatsAppService } from './ramp.whatsapp';

export type BankSendQuote = {
  amountNgn: number;
  amountUsdc: number;
  rate: number;
};

export type SpendChain = 'stellar' | 'celo';

/**
 * WhatsApp Naira services: bank list / resolve + USDC→FalconPay bank send.
 */
@Injectable()
export class RampNairaService {
  constructor(
    private readonly payouts: PayoutService,
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
    private readonly stellar: RampStellarWalletService,
    private readonly celo: RampCeloWalletService,
    private readonly store: RampStoreService,
    private readonly whatsapp: RampWhatsAppService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampNairaService.name);
  }

  async listBanks(): Promise<Bank[]> {
    return this.payouts.listBanks();
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    return this.payouts.resolveAccount(accountNumber, bankCode);
  }

  /** Case-insensitive substring match; prefer starts-with. Cap at 10 for WA lists. */
  filterBanks(banks: Bank[], query: string): Bank[] {
    const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return banks.slice(0, 10);
    const scored = banks
      .map((b) => {
        const name = b.name.toLowerCase();
        const code = b.code.toLowerCase();
        let score = 0;
        if (name === q || code === q) score = 100;
        else if (name.startsWith(q)) score = 80;
        else if (name.includes(q)) score = 50;
        else if (code.includes(q)) score = 40;
        return { b, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.b.name.localeCompare(b.b.name));
    return scored.slice(0, 10).map((x) => x.b);
  }

  /**
   * Resolve a payout bank against FalconPay's live list **before** crypto moves.
   *
   * Saved codes can be stale (legacy profile migration, provider renames). A code
   * that is not on the list must fail here — not after USDC has already been sent.
   */
  async resolveSupportedBank(
    bankCode: string,
    bankName: string,
  ): Promise<{ code: string; name: string }> {
    const banks = await this.listBanks();
    const normalizedCode = bankCode.trim();
    const normalizedName = bankName.trim();

    if (normalizedCode) {
      const exact = banks.find((candidate) => candidate.code === normalizedCode);
      if (exact) return { code: exact.code, name: exact.name };
    }

    const matches = this.filterBanks(banks, normalizedName);
    if (matches.length === 1) {
      return { code: matches[0]!.code, name: matches[0]!.name };
    }
    if (matches.length > 1) {
      const exactName = matches.find(
        (candidate) => candidate.name.toLowerCase() === normalizedName.toLowerCase(),
      );
      if (exactName) return { code: exactName.code, name: exactName.name };
    }

    throw new AppException(ErrorCode.VALIDATION_FAILED, {
      message:
        'That bank is not supported for transfers. Update your payout bank (Sell → Use different) and pick from the list.',
      details: { bankCode: normalizedCode, bankName: normalizedName },
    });
  }

  quoteUsdcForNgn(amountNgn: number): BankSendQuote {
    const config = getRampConfig();
    const rate = config.rates.sellNgn;
    if (!rate || rate <= 0) {
      throw new Error('Sell rate is not configured');
    }
    const raw = amountNgn / rate;
    const amountUsdc = Math.round(raw * 1e6) / 1e6;
    return { amountNgn, amountUsdc, rate };
  }

  newBankSendRef(): string {
    return `bs_${randomBytes(6).toString('hex')}`;
  }

  /**
   * Debit Stellar USDC or Celo digital dollars → operator vault, then FalconPay.
   */
  async executeBankSend(opts: {
    phone: string;
    zyloWallet: string;
    amountNgn: number;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    chain?: SpendChain;
    /**
     * Locked sell quote: debit this USDC and pay `amountNgn` (skip NGN→USDC re-quote).
     * Used by Sell USDC so the WhatsApp quote matches the chain debit.
     */
    amountUsdc?: number;
    rate?: number;
    /**
     * Web portal: return as soon as FalconPay accepts the payout. Do not wait
     * for settlement — a slow status poll times out the browser after USDC has
     * already left. Completion + WhatsApp receipt still arrive via webhook /
     * receipt retries.
     */
    deferSettlement?: boolean;
  }): Promise<{
    ref: string;
    amountUsdc: number;
    amountNgn: number;
    chain: SpendChain;
    stellarTxHash: string | null;
    celoTxHash: string | null;
    message: string;
    receiptPng: Buffer | null;
    /** True when FalconPay confirmed the bank payout in this request. */
    completed: boolean;
  }> {
    const config = getRampConfig();
    if (!config.tenantId) {
      throw new Error('Bank transfers need WA_RAMP_TENANT_ID (platform tenant for Naira payouts).');
    }

    const chain: SpendChain = opts.chain === 'celo' ? 'celo' : 'stellar';
    const stellarVault = config.stellar.depositAddress;
    const celoVault = config.celo.depositAddress;

    if (chain === 'stellar') {
      if (!stellarVault || !/^[GC][A-Z0-9]{55}$/i.test(stellarVault)) {
        throw new Error('Operator Stellar vault (WA_RAMP_STELLAR_DEPOSIT_ADDRESS) is not set.');
      }
    } else if (!celoVault || !/^0x[a-fA-F0-9]{40}$/.test(celoVault)) {
      throw new Error('Operator Celo deposit (WA_RAMP_CELO_DEPOSIT_ADDRESS) is not set.');
    }

    let amountNgn = Math.round(opts.amountNgn);
    let amountUsdc: number;
    let rate: number;
    if (opts.amountUsdc != null && opts.amountUsdc > 0) {
      amountUsdc = Math.round(opts.amountUsdc * 1e6) / 1e6;
      rate = opts.rate && opts.rate > 0 ? opts.rate : config.rates.sellNgn;
    } else {
      const quoted = this.quoteUsdcForNgn(opts.amountNgn);
      amountNgn = quoted.amountNgn;
      amountUsdc = quoted.amountUsdc;
      rate = quoted.rate;
    }
    if (amountNgn < config.minBankSendNgn || amountNgn > config.maxBankSendNgn) {
      throw new Error(
        `Amount must be between ₦${config.minBankSendNgn.toLocaleString('en-NG')} and ₦${config.maxBankSendNgn.toLocaleString('en-NG')}.`,
      );
    }
    if (amountUsdc <= 0) {
      throw new Error('USDC amount too small for this Naira amount at current rates.');
    }

    const bank = await this.resolveSupportedBank(opts.bankCode, opts.bankName);
    const bankCode = bank.code;
    const bankName = bank.name;

    if (chain === 'stellar') {
      const bal = await this.stellar.getBalances(opts.zyloWallet);
      const usdcAvail = Number(formatSacAmount(bal.usdc));
      if (usdcAvail + 1e-9 < amountUsdc) {
        throw new Error(
          `Insufficient USDC. Need ~${amountUsdc} USDC, you have ${formatSacAmount(bal.usdc)}.`,
        );
      }
    } else {
      const celoAddr = await this.celo.provisionWallet(opts.phone);
      if (!celoAddr) {
        throw new Error('Your Celo wallet is not ready yet.');
      }
      const bal = await this.celo.getStableBalances(celoAddr);
      if (bal.total + 1e-9 < amountUsdc) {
        throw new Error(
          `Insufficient Celo digital dollars. Need ~${formatCeloStable(amountUsdc)}, you have ${formatCeloStable(bal.total)}.`,
        );
      }
    }

    const ref = this.newBankSendRef();
    const platformUserId = await this.ensurePlatformUser(opts.phone, config.tenantId);

    await this.store.createBankSend({
      ref,
      phone: opts.phone,
      amountNgn,
      amountUsdc,
      rate,
      bankCode,
      bankName,
      accountNumber: opts.accountNumber,
      accountName: opts.accountName,
      status: 'awaiting_crypto',
      platformUserId,
      chain,
    });

    let stellarTxHash: string | null = null;
    let celoTxHash: string | null = null;
    try {
      if (chain === 'stellar') {
        stellarTxHash = await this.stellar.transferUsdc(
          opts.zyloWallet,
          stellarVault,
          amountUsdc,
          opts.phone,
        );
      } else {
        const transferred = await this.celo.transferStable({
          phone: opts.phone,
          to: celoVault,
          amount: amountUsdc,
        });
        celoTxHash = transferred.txHash;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.store.updateBankSend(ref, {
        status: 'failed',
        failureReason: reason.slice(0, 512),
        completedAt: new Date(),
      });
      throw e;
    }

    await this.store.updateBankSend(ref, {
      status: 'crypto_sent',
      stellarTxHash,
      celoTxHash,
      chain,
    });

    const paidLabel =
      chain === 'celo'
        ? `Paid with ~${formatCeloStable(amountUsdc)} digital dollars (Celo)`
        : `Paid with ~${amountUsdc} USDC (Stellar)`;
    const cryptoHash = stellarTxHash || celoTxHash || '';

    try {
      const payoutRef = await RequestContext.run(
        {
          tenantId: config.tenantId,
          actorType: ActorType.System,
          userId: platformUserId,
        },
        async () => {
          const creditRef = `${ref}_credit`;
          await this.wallet.credit({
            userId: platformUserId,
            amount: Money.fromNaira(amountNgn),
            type: LedgerEntryType.ADJUSTMENT,
            reference: creditRef,
            narration: `WhatsApp bank send →NGN (${amountUsdc} via ${chain}) · ${ref}`,
          });

          const payout = await this.payouts.requestPayout({
            userId: platformUserId,
            amount: Money.fromNaira(amountNgn),
            bankCode,
            accountNumber: opts.accountNumber,
            narration: `BANJEE ${ref}`,
            idempotencyKey: ref,
          });

          // Relink the credit leg to the payout reference so the portal can
          // group both ledger rows as one user-facing bank send.
          if (payout.reference && payout.reference !== ref) {
            await this.prisma.walletLedgerEntry.updateMany({
              where: { reference: creditRef, userId: platformUserId },
              data: {
                reference: `${payout.reference}_credit`,
                narration: `WhatsApp bank send →NGN (${amountUsdc} via ${chain}) · ${payout.reference}`,
              },
            });
          }

          // Webhooks key on payout.reference (PAY-…), not our bs_ draft id.
          await this.prisma.zyRampBankSend.update({
            where: { ref },
            data: {
              ref: payout.reference,
              status: 'processing',
              providerReference: payout.providerReference || null,
            },
          });

          return payout.reference;
        },
      );

      const finalRef = payoutRef || ref;

      const submittedMessage = [
        `Submitted to bank`,
        `₦${amountNgn.toLocaleString('en-NG')} → ${opts.accountName}`,
        `${bankName} · ${opts.accountNumber}`,
        paidLabel,
        `Ref ${finalRef}`,
        '',
        'You will get a green receipt when the payment clears.',
      ].join('\n');

      // Portal must not block on FalconPay settlement — the HTTP client times out
      // and shows a false failure after USDC has already left the wallet.
      if (opts.deferSettlement) {
        this.scheduleBankSendReceiptRetries(finalRef);
        return {
          ref: finalRef,
          amountUsdc,
          amountNgn,
          chain,
          stellarTxHash,
          celoTxHash,
          receiptPng: null,
          completed: false,
          message: submittedMessage,
        };
      }

      const outcome = await this.reconcileBankSendNotification(finalRef, {
        deliverWhatsApp: false,
      });
      if (!outcome.completed) {
        this.scheduleBankSendReceiptRetries(finalRef);
      }

      if (outcome.completed && outcome.receipt) {
        return {
          ref: finalRef,
          amountUsdc,
          amountNgn,
          chain,
          stellarTxHash,
          celoTxHash,
          receiptPng: outcome.receipt.receiptPng,
          message: outcome.receipt.caption,
          completed: true,
        };
      }

      if (outcome.completed) {
        return {
          ref: finalRef,
          amountUsdc,
          amountNgn,
          chain,
          stellarTxHash,
          celoTxHash,
          receiptPng: null,
          message: '',
          completed: true,
        };
      }

      return {
        ref: finalRef,
        amountUsdc,
        amountNgn,
        chain,
        stellarTxHash,
        celoTxHash,
        receiptPng: null,
        completed: false,
        message: submittedMessage,
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const code = e instanceof AppException ? e.code : undefined;
      this.logger.error(
        { err: reason, code, ref, phone: opts.phone, chain },
        '[zylo-ramp] FalconPay payout failed after crypto debit — needs ops review',
      );
      await this.store
        .updateBankSend(ref, {
          status: 'payout_failed',
          failureReason: reason.slice(0, 512),
        })
        .catch(() => undefined);
      throw new Error(
        `Crypto was collected (tx ${cryptoHash.slice(0, 10)}…) but the bank payout failed. Ref ${ref}. Support will complete or refund.`,
      );
    }
  }

  /**
   * Delivers the green receipt when FalconPay reports completion — via webhook,
   * a synchronous transfer response, or a status poll.
   */
  async reconcileBankSendNotification(
    reference: string,
    opts?: { deliverWhatsApp?: boolean },
  ): Promise<{
    completed: boolean;
    failed: boolean;
    receipt: { receiptPng: Buffer; caption: string } | null;
  }> {
    const deliverWhatsApp = opts?.deliverWhatsApp ?? true;
    const empty = { completed: false, failed: false, receipt: null };

    const send = await this.store.findBankSendByRef(reference).catch(() => null);
    if (send?.status === 'completed') {
      return { completed: true, failed: false, receipt: null };
    }
    if (send?.status === 'failed') {
      return { completed: false, failed: true, receipt: null };
    }

    const payout = await this.prisma.payout.findFirst({
      where: { reference },
      select: { status: true, failureReason: true },
    });
    if (payout?.status === PayoutStatus.COMPLETED) {
      const receipt = await this.onPayoutTerminal({
        reference,
        status: 'completed',
        deliverWhatsApp,
      });
      return { completed: true, failed: false, receipt };
    }
    if (payout?.status === PayoutStatus.FAILED) {
      await this.onPayoutTerminal({
        reference,
        status: 'failed',
        message: payout.failureReason ?? undefined,
        deliverWhatsApp,
      });
      return { completed: false, failed: true, receipt: null };
    }

    const applied = await this.payouts.pollTransferStatus(reference);
    if (!applied) return empty;

    const refreshed = await this.prisma.payout.findFirst({
      where: { reference },
      select: { status: true, failureReason: true },
    });
    if (refreshed?.status === PayoutStatus.COMPLETED) {
      const receipt = await this.onPayoutTerminal({
        reference,
        status: 'completed',
        deliverWhatsApp,
      });
      return { completed: true, failed: false, receipt };
    }
    if (refreshed?.status === PayoutStatus.FAILED) {
      await this.onPayoutTerminal({
        reference,
        status: 'failed',
        message: refreshed.failureReason ?? undefined,
        deliverWhatsApp,
      });
      return { completed: false, failed: true, receipt: null };
    }

    return empty;
  }

  /** Poll FalconPay a few more times when webhooks never arrive. */
  private scheduleBankSendReceiptRetries(reference: string): void {
    for (const delayMs of [30_000, 90_000, 180_000]) {
      const timer = setTimeout(() => {
        void this.reconcileBankSendNotification(reference).catch((error) => {
          this.logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              reference,
              delayMs,
            },
            '[zylo-ramp] delayed bank-send receipt retry failed',
          );
        });
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  /**
   * WhatsApp receipt for an NGN-ledger bank send from the web app (`POST /payouts`).
   * Ramp USDC→bank sends are handled by {@link onPayoutTerminal}; this covers the
   * pure Naira-balance path that has no ZyRampBankSend row.
   */
  async notifyLedgerPayoutTerminal(opts: {
    reference: string;
    status: 'completed' | 'failed';
    message?: string;
  }): Promise<void> {
    const rampSend = await this.store.findBankSendByRef(opts.reference).catch(() => null);
    if (rampSend) return;

    const payout = await RequestContext.runAsSystem({}, async () =>
      this.prisma.payout.findFirst({
        where: { reference: opts.reference },
        select: {
          status: true,
          amount: true,
          accountName: true,
          bankName: true,
          accountNumber: true,
          reference: true,
          failureReason: true,
          user: { select: { phoneE164: true } },
        },
      }),
    );
    if (!payout?.user?.phoneE164) return;

    const phone =
      Phone.toWhatsAppId(payout.user.phoneE164) || payout.user.phoneE164.replace(/\D/g, '');
    if (!phone) return;

    if (opts.status === 'failed') {
      await this.whatsapp
        .sendText(
          phone,
          [
            `⚠️ Bank transfer failed for ref ${payout.reference}`,
            opts.message || payout.failureReason || 'The payout was rejected.',
            'Your naira balance has been restored if the hold was released.',
          ].join('\n'),
        )
        .catch((e) => {
          this.logger.warn(
            { err: e instanceof Error ? e.message : String(e), ref: payout.reference },
            '[zylo-ramp] ledger payout failure notify failed',
          );
        });
      return;
    }

    if (opts.status !== 'completed') return;
    if (payout.status !== PayoutStatus.COMPLETED) return;

    const amountNgn = Number(Money.fromKobo(payout.amount, 'NGN').toJSON().amount);
    const caption = [
      `✅ Successful — ₦${amountNgn.toLocaleString('en-NG')} paid to ${payout.accountName}`,
      `${payout.bankName} · ${payout.accountNumber}`,
      `Ref ${payout.reference}`,
    ].join('\n');

    const rampUser = await this.store.getUser(phone).catch(() => null);
    const receiptPng = await renderBankSendReceiptPng({
      brandName: getRampConfig().brandName,
      amountNgn,
      amountUsdc: null,
      accountName: payout.accountName,
      bankName: payout.bankName,
      accountNumber: payout.accountNumber,
      ref: payout.reference,
      stellarTxHash: null,
      username: rampUser?.username,
      status: 'completed',
    });

    await this.deliverBankSendReceipt(phone, { receiptPng, caption });
  }

  /** Called from FalconPay webhook path when a terminal payout event lands. */
  async onPayoutTerminal(opts: {
    reference: string;
    status: 'completed' | 'failed';
    message?: string;
    /** When false, only update state and return receipt bytes for the caller to send once. */
    deliverWhatsApp?: boolean;
  }): Promise<{ receiptPng: Buffer; caption: string } | null> {
    const send = await this.store.findBankSendByRef(opts.reference).catch(() => null);
    if (!send) {
      // NGN ledger withdraw from the web app — still send WhatsApp text + receipt.
      if (opts.deliverWhatsApp !== false) {
        await this.notifyLedgerPayoutTerminal(opts).catch((err: unknown) => {
          this.logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              reference: opts.reference,
            },
            '[zylo-ramp] ledger bank-send WhatsApp notify failed',
          );
        });
      }
      return null;
    }
    if (send.status === 'completed' || send.status === 'failed') return null;

    if (opts.status === 'completed') {
      await this.store.updateBankSend(opts.reference, {
        status: 'completed',
        completedAt: new Date(),
      });

      const receipt = await this.buildCompletedBankSendReceipt(send);
      if (opts.deliverWhatsApp !== false) {
        await this.deliverBankSendReceipt(send.phone, receipt);
      }
      return receipt;
    }

    await this.store.updateBankSend(opts.reference, {
      status: 'failed',
      failureReason: (opts.message || 'Payout failed').slice(0, 512),
      completedAt: new Date(),
    });
    if (opts.deliverWhatsApp !== false) {
      await this.whatsapp
        .sendText(
          send.phone,
          [
            `⚠️ Bank transfer failed for ref ${send.ref}`,
            opts.message || 'The payout was rejected.',
            'Support will help with a refund if needed.',
          ].join('\n'),
        )
        .catch((e) => {
          this.logger.warn(
            { err: e instanceof Error ? e.message : String(e), ref: send.ref },
            '[zylo-ramp] bank send failure notify failed',
          );
        });
    }
    return null;
  }

  private async buildCompletedBankSendReceipt(send: {
    ref: string;
    phone: string;
    amountNgn: number;
    amountUsdc: number;
    accountName: string;
    bankName: string;
    accountNumber: string;
    stellarTxHash: string | null;
  }): Promise<{ receiptPng: Buffer; caption: string }> {
    const caption = [
      `✅ Successful — ₦${send.amountNgn.toLocaleString('en-NG')} paid to ${send.accountName}`,
      `${send.bankName} · ${send.accountNumber}`,
      `Ref ${send.ref}`,
    ].join('\n');

    const rampUser = await this.store.getUser(send.phone).catch(() => null);
    const receiptPng = await renderBankSendReceiptPng({
      brandName: getRampConfig().brandName,
      amountNgn: send.amountNgn,
      amountUsdc: send.amountUsdc,
      accountName: send.accountName,
      bankName: send.bankName,
      accountNumber: send.accountNumber,
      ref: send.ref,
      stellarTxHash: send.stellarTxHash,
      username: rampUser?.username,
      status: 'completed',
    });

    return { receiptPng, caption };
  }

  private async deliverBankSendReceipt(
    phone: string,
    receipt: { receiptPng: Buffer; caption: string },
  ): Promise<void> {
    // Text first — media upload can fail while the customer still needs the update.
    await this.whatsapp.sendText(phone, receipt.caption).catch((err) => {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), phone },
        '[zylo-ramp] bank send success text notify failed',
      );
    });
    try {
      await this.whatsapp.sendImage(phone, {
        buffer: receipt.receiptPng,
        mimeType: 'image/png',
        filename: 'banjee-bank-receipt.png',
        caption: receipt.caption,
      });
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), phone },
        '[zylo-ramp] bank send paid receipt image failed',
      );
    }
  }

  /**
   * WhatsApp sell needs a platform User + NGN wallet for FalconPay.
   *
   * Lookup must not require `type: CUSTOMER`. Ops phones that signed into the
   * web portal are promoted to ADMIN; filtering them out then `create()`s a
   * duplicate and hits `@@unique([tenantId, phoneE164])`. Soft-deleted rows
   * occupy that unique too, so reads include them (`deletedAt: undefined`).
   */
  private async findPlatformUserByPhone(tenantId: string, phoneE164: string) {
    return this.prisma.user.findFirst({
      where: { tenantId, phoneE164, deletedAt: undefined },
      select: { id: true, deletedAt: true, wallet: { select: { id: true } } },
    });
  }

  private async attachNgnWallet(tenantId: string, userId: string): Promise<void> {
    try {
      await this.prisma.wallet.create({
        data: { tenantId, userId, currency: 'NGN' },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
  }

  private async reusePlatformUser(
    tenantId: string,
    existing: { id: string; deletedAt: Date | null; wallet: { id: string } | null },
  ): Promise<string> {
    if (existing.deletedAt) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { deletedAt: null, status: UserStatus.ACTIVE },
      });
    }
    if (!existing.wallet) {
      await this.attachNgnWallet(tenantId, existing.id);
    }
    return existing.id;
  }

  private async ensurePlatformUser(phone: string, tenantId: string): Promise<string> {
    const phoneE164 =
      Phone.fromWhatsAppId(phone) || Phone.normalize(phone) || Phone.normalizeOrThrow(phone);

    return RequestContext.runAsSystem({}, async () => {
      const existing = await this.findPlatformUserByPhone(tenantId, phoneE164);
      if (existing) {
        return this.reusePlatformUser(tenantId, existing);
      }

      const ramp = await this.store.getUser(phone).catch(() => null);
      const usernameBase = (ramp?.username || `wa${phoneE164.replace(/\D/g, '').slice(-10)}`)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 28);
      const username = `${usernameBase}_${createHash('sha256').update(phoneE164).digest('hex').slice(0, 4)}`;

      try {
        const created = await this.prisma.user.create({
          data: {
            tenantId,
            type: UserType.CUSTOMER,
            phoneE164,
            email: ramp?.email || undefined,
            username,
            fullName: ramp?.whatsappName || ramp?.username || undefined,
            status: UserStatus.ACTIVE,
            wallet: { create: { tenantId, currency: 'NGN' } },
          },
          select: { id: true },
        });

        this.logger.info(
          { userId: created.id, tenantId, phone: Phone.mask(phoneE164) },
          '[zylo-ramp] linked WhatsApp phone to platform user for Naira payouts',
        );
        return created.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const raced = await this.findPlatformUserByPhone(tenantId, phoneE164);
          if (raced) return this.reusePlatformUser(tenantId, raced);
        }
        throw e;
      }
    });
  }
}
