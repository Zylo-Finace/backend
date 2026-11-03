import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { Money } from '../../core/money/money';
import { BillsCatalogueService } from '../bills/bills.catalogue';
import { BillsService } from '../bills/bills.service';
import {
  BillOrderStatus,
  type CableProvider,
  type DataPlan,
  type MeterType,
  MobileNetwork,
  isRefundableBillStatus,
} from '../bills/bills-provider.interface';
import { isSmePlugPlanCode } from '../bills/smeplug.provider';
import { getRampConfig } from './ramp.config';
import { formatCeloStable, RampCeloWalletService } from './ramp.celo-wallet';
import { renderAirtimeReceiptPng } from './ramp.receipt';
import { RampNairaService, type SpendChain } from './ramp.naira';
import { formatSacAmount, RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStoreService } from './ramp.store';

export const AIRTIME_NETWORKS: Array<{ id: MobileNetwork; label: string }> = [
  { id: MobileNetwork.Mtn, label: 'MTN' },
  { id: MobileNetwork.Glo, label: 'Glo' },
  { id: MobileNetwork.NineMobile, label: '9mobile' },
  { id: MobileNetwork.Airtel, label: 'Airtel' },
];

/** WhatsApp airtime face-value bounds. */
export const AIRTIME_MIN_NGN = 50;
export const AIRTIME_MAX_NGN = 20_000;

/** WhatsApp list row cap. */
export const DATA_PLAN_LIST_LIMIT = 10;

export type RampDataPlanOption = {
  code: string;
  name: string;
  amountNgn: number;
};

function moneyToWholeNaira(amount: Money): number {
  return Number(amount.kobo / 100n);
}

function appExceptionMessage(e: AppException): string {
  const body = e.getResponse();
  if (typeof body === 'object' && body && 'message' in body && typeof body.message === 'string') {
    const details =
      'details' in body && body.details && typeof body.details === 'object'
        ? (body.details as Record<string, unknown>)
        : null;
    const providerMessage =
      details && typeof details.providerMessage === 'string' ? details.providerMessage.trim() : '';
    if (providerMessage && providerMessage !== body.message) {
      return `${body.message}: ${providerMessage}`;
    }
    return body.message;
  }
  return e.message;
}

/** User-facing airtime failure copy (provider ops issues → clear next step). */
function airtimeFailureHint(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('vtu_declined')) {
    return [
      'Airtime provider temporarily unavailable.',
      'Your USDC was refunded if it was taken. Try again later, or buy data instead.',
    ].join('\n');
  }
  if (lower.includes('unable to purchase airtime') || lower.includes('no device')) {
    return [
      reason,
      '',
      'Airtime is temporarily unavailable from our provider.',
      'Your USDC was refunded if it was taken. Try again later, or buy data instead.',
    ].join('\n');
  }
  if (lower.includes('account_mismatch') || lower.includes('account mismatch')) {
    return [
      'Airtime provider account error — support has been notified.',
      'Your USDC was refunded if it was taken. Try again later.',
    ].join('\n');
  }
  return reason;
}

/**
 * WhatsApp airtime + data: Stellar USDC or Celo dollars → bills provider
 * (SMEPlug when `BILLS_PROVIDER=smeplug`, with ClubKonnect fallback).
 */
@Injectable()
export class RampBillsService {
  constructor(
    private readonly bills: BillsService,
    private readonly catalogue: BillsCatalogueService,
    private readonly naira: RampNairaService,
    private readonly stellar: RampStellarWalletService,
    private readonly celo: RampCeloWalletService,
    private readonly store: RampStoreService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampBillsService.name);
  }

  networkLabel(code: MobileNetwork | string): string {
    const id = String(code);
    return AIRTIME_NETWORKS.find((n) => String(n.id) === id)?.label || id;
  }

  private billStatus(status: BillOrderStatus): string {
    if (status === BillOrderStatus.Completed) return 'completed';
    if (isRefundableBillStatus(status)) return 'failed';
    return 'submitted';
  }

  private async recordBillPurchase(input: {
    ref: string;
    phone: string;
    vertical: 'airtime' | 'data' | 'electricity' | 'cable' | 'betting';
    amountNgn: number;
    amountUsdc: number;
    rate: number;
    productLabel?: string | null;
    customerId?: string | null;
    customerName?: string | null;
    status: BillOrderStatus;
    chain: SpendChain;
    stellarTxHash?: string | null;
    celoTxHash?: string | null;
    providerReference?: string | null;
  }): Promise<void> {
    try {
      await this.store.createBillPurchase({
        ...input,
        status: this.billStatus(input.status),
      });
    } catch (e) {
      this.logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          ref: input.ref,
          vertical: input.vertical,
        },
        '[zylo-ramp] bill purchase audit row failed',
      );
    }
  }

  /**
   * Data plans for WhatsApp list — prefer SMEPlug (`sp:…`) codes, cheapest first.
   */
  async listDataPlansForNetwork(network: MobileNetwork): Promise<RampDataPlanOption[]> {
    const plans = await this.catalogue.dataPlansFor(network);
    const ranked = [...plans].sort((a, b) => {
      const aSp = isSmePlugPlanCode(a.code) ? 0 : 1;
      const bSp = isSmePlugPlanCode(b.code) ? 0 : 1;
      if (aSp !== bSp) return aSp - bSp;
      return moneyToWholeNaira(a.price) - moneyToWholeNaira(b.price);
    });
    return ranked.slice(0, DATA_PLAN_LIST_LIMIT).map((plan: DataPlan) => ({
      code: plan.code,
      name: plan.name,
      amountNgn: moneyToWholeNaira(plan.price),
    }));
  }

  private async assertVaultAndBalance(opts: {
    phone: string;
    zyloWallet: string;
    chain: SpendChain;
    amountUsdc: number;
    product: string;
  }): Promise<{ stellarVault: string; celoVault: string }> {
    const config = getRampConfig();
    const stellarVault = config.stellar.depositAddress;
    const celoVault = config.celo.depositAddress;

    if (opts.chain === 'stellar') {
      if (!stellarVault || !/^[GC][A-Z0-9]{55}$/i.test(stellarVault)) {
        throw new Error('Operator Stellar vault (WA_RAMP_STELLAR_DEPOSIT_ADDRESS) is not set.');
      }
      const bal = await this.stellar.getBalances(opts.zyloWallet);
      const usdcAvail = Number(formatSacAmount(bal.usdc));
      if (usdcAvail + 1e-9 < opts.amountUsdc) {
        throw new Error(
          `Insufficient USDC. Need ~${opts.amountUsdc} USDC, you have ${formatSacAmount(bal.usdc)}.`,
        );
      }
    } else {
      if (!celoVault || !/^0x[a-fA-F0-9]{40}$/.test(celoVault)) {
        throw new Error('Operator Celo deposit (WA_RAMP_CELO_DEPOSIT_ADDRESS) is not set.');
      }
      const celoAddr = await this.celo.provisionWallet(opts.phone);
      if (!celoAddr) {
        throw new Error('Your Celo wallet is not ready yet.');
      }
      const bal = await this.celo.getStableBalances(celoAddr);
      if (bal.total + 1e-9 < opts.amountUsdc) {
        throw new Error(
          `Insufficient Celo digital dollars. Need ~${formatCeloStable(opts.amountUsdc)}, you have ${formatCeloStable(bal.total)}.`,
        );
      }
    }

    return { stellarVault, celoVault };
  }

  private async debitCrypto(opts: {
    phone: string;
    zyloWallet: string;
    chain: SpendChain;
    amountUsdc: number;
    stellarVault: string;
    celoVault: string;
    ref: string;
    product: string;
  }): Promise<{ stellarTxHash: string | null; celoTxHash: string | null }> {
    let stellarTxHash: string | null = null;
    let celoTxHash: string | null = null;
    try {
      if (opts.chain === 'stellar') {
        stellarTxHash = await this.stellar.transferUsdc(
          opts.zyloWallet,
          opts.stellarVault,
          opts.amountUsdc,
          opts.phone,
        );
      } else {
        const transferred = await this.celo.transferStable({
          phone: opts.phone,
          to: opts.celoVault,
          amount: opts.amountUsdc,
        });
        celoTxHash = transferred.txHash;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        { err: reason, ref: opts.ref, phone: opts.phone, chain: opts.chain },
        `[zylo-ramp] ${opts.product} crypto debit failed`,
      );
      throw e;
    }
    return { stellarTxHash, celoTxHash };
  }

  private async refundCryptoAfterFailedBill(opts: {
    product: string;
    chain: SpendChain;
    amountUsdc: number;
    zyloWallet: string;
    phone: string;
    cryptoHash: string;
    ref: string;
    reason: string;
  }): Promise<never> {
    const { product, chain, amountUsdc, zyloWallet, phone, cryptoHash, ref, reason } = opts;

    if (chain === 'stellar' && /^G[A-Z0-9]{55}$/i.test(zyloWallet)) {
      try {
        const refundHash = await this.stellar.refundUsdcFromVault(zyloWallet, amountUsdc);
        this.logger.warn(
          { ref, phone, amountUsdc, cryptoHash, refundHash, reason },
          `[zylo-ramp] ${product} failed after debit — USDC refunded to user`,
        );
        throw new Error(
          `${product} failed (${reason}). Your ~${amountUsdc} USDC was refunded. Tx ${refundHash.slice(0, 10)}… Ref ${ref}.`,
        );
      } catch (e) {
        if (e instanceof Error && e.message.includes('was refunded')) throw e;
        const refundErr = e instanceof Error ? e.message : String(e);
        this.logger.error(
          { err: refundErr, ref, cryptoHash, phone, amountUsdc },
          `[zylo-ramp] ${product} failed after debit AND refund failed — needs ops`,
        );
        throw new Error(
          `Crypto was collected (tx ${cryptoHash.slice(0, 10)}…) but ${product} failed: ${reason}. Automatic refund also failed (${refundErr}). Ref ${ref}. Support will help.`,
        );
      }
    }

    this.logger.error(
      { ref, cryptoHash, phone, chain, amountUsdc, reason },
      `[zylo-ramp] ${product} failed after crypto debit — needs ops review`,
    );
    throw new Error(
      `Crypto was collected (tx ${cryptoHash.slice(0, 10)}…) but ${product} failed: ${reason}. Ref ${ref}. Support will help.`,
    );
  }

  async executeAirtime(opts: {
    phone: string;
    zyloWallet: string;
    network: MobileNetwork;
    recipientPhone: string;
    amountNgn: number;
    chain?: SpendChain;
  }): Promise<{
    ref: string;
    amountUsdc: number;
    amountNgn: number;
    chain: SpendChain;
    stellarTxHash: string | null;
    celoTxHash: string | null;
    orderId: string | null;
    status: BillOrderStatus;
    receiptPng: Buffer | null;
    message: string;
  }> {
    const config = getRampConfig();
    const chain: SpendChain = opts.chain === 'celo' ? 'celo' : 'stellar';

    const amountNgn = Math.round(opts.amountNgn);
    if (amountNgn < AIRTIME_MIN_NGN || amountNgn > AIRTIME_MAX_NGN) {
      throw new Error(
        `Airtime must be between ₦${AIRTIME_MIN_NGN.toLocaleString('en-NG')} and ₦${AIRTIME_MAX_NGN.toLocaleString('en-NG')}.`,
      );
    }

    const { amountUsdc, rate } = this.naira.quoteUsdcForNgn(amountNgn);
    if (amountUsdc <= 0) {
      throw new Error('USDC amount too small for this airtime at current rates.');
    }

    const { stellarVault, celoVault } = await this.assertVaultAndBalance({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      product: 'airtime',
    });

    try {
      await this.bills.assertFloatCovers(Money.fromNaira(amountNgn), {
        vertical: 'airtime',
        phone: opts.phone,
      });
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }

    const ref = `at_${randomBytes(6).toString('hex')}`;
    const networkLabel = this.networkLabel(opts.network);

    const { stellarTxHash, celoTxHash } = await this.debitCrypto({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      stellarVault,
      celoVault,
      ref,
      product: 'airtime',
    });
    const cryptoHash = stellarTxHash || celoTxHash || '';

    let purchase;
    try {
      purchase = await this.bills.buyAirtime({
        network: opts.network,
        phoneNumber: opts.recipientPhone,
        amount: Money.fromNaira(amountNgn),
        reference: ref,
      });
    } catch (e) {
      const raw =
        e instanceof AppException
          ? appExceptionMessage(e)
          : e instanceof Error
            ? e.message
            : String(e);
      return this.refundCryptoAfterFailedBill({
        product: 'airtime',
        chain,
        amountUsdc,
        zyloWallet: opts.zyloWallet,
        phone: opts.phone,
        cryptoHash,
        ref,
        reason: airtimeFailureHint(raw),
      });
    }

    const order = purchase.order;
    const orderId = order.providerOrderId || order.reference || ref;
    const rampUser = await this.store.getUser(opts.phone).catch(() => null);

    let receiptPng: Buffer | null = null;
    try {
      receiptPng = await renderAirtimeReceiptPng({
        brandName: config.brandName,
        amountNgn,
        amountUsdc,
        networkLabel,
        recipientPhone: opts.recipientPhone,
        ref,
        orderId: String(orderId),
        stellarTxHash: cryptoHash,
        username: rampUser?.username,
        status:
          order.status === BillOrderStatus.Completed
            ? 'completed'
            : isRefundableBillStatus(order.status)
              ? 'failed'
              : 'submitted',
      });
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), ref },
        '[zylo-ramp] airtime receipt image failed',
      );
    }

    const statusNote =
      order.status === BillOrderStatus.Completed
        ? 'Airtime delivered.'
        : isRefundableBillStatus(order.status)
          ? 'Provider refused — support will help with a refund.'
          : 'Top-up submitted — usually lands in under a minute.';

    const paidLabel =
      chain === 'celo'
        ? `Paid with ~${formatCeloStable(amountUsdc)} digital dollars (Celo)`
        : `Paid with ~${amountUsdc} USDC (Stellar)`;

    await this.recordBillPurchase({
      ref,
      phone: opts.phone,
      vertical: 'airtime',
      amountNgn,
      amountUsdc,
      rate,
      productLabel: networkLabel,
      customerId: opts.recipientPhone,
      status: order.status,
      chain,
      stellarTxHash,
      celoTxHash,
      providerReference: String(orderId),
    });

    return {
      ref,
      amountUsdc,
      amountNgn,
      chain,
      stellarTxHash,
      celoTxHash,
      orderId: String(orderId),
      status: order.status,
      receiptPng,
      message: [
        order.status === BillOrderStatus.Completed ? '✅ Airtime sent' : '⏳ Airtime submitted',
        `₦${amountNgn.toLocaleString('en-NG')} ${networkLabel} → ${opts.recipientPhone}`,
        `${paidLabel} (₦${rate}/USDC)`,
        `Ref ${ref}`,
        orderId && orderId !== ref ? `Provider ${orderId}` : '',
        statusNote,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  async executeData(opts: {
    phone: string;
    zyloWallet: string;
    network: MobileNetwork;
    recipientPhone: string;
    planCode: string;
    planName: string;
    amountNgn: number;
    chain?: SpendChain;
  }): Promise<{
    ref: string;
    amountUsdc: number;
    amountNgn: number;
    chain: SpendChain;
    stellarTxHash: string | null;
    celoTxHash: string | null;
    orderId: string | null;
    status: BillOrderStatus;
    receiptPng: Buffer | null;
    message: string;
  }> {
    const config = getRampConfig();
    const chain: SpendChain = opts.chain === 'celo' ? 'celo' : 'stellar';
    const amountNgn = Math.round(opts.amountNgn);
    if (amountNgn < 1) {
      throw new Error('Invalid data plan price.');
    }

    const { amountUsdc, rate } = this.naira.quoteUsdcForNgn(amountNgn);
    if (amountUsdc <= 0) {
      throw new Error('USDC amount too small for this data plan at current rates.');
    }

    const { stellarVault, celoVault } = await this.assertVaultAndBalance({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      product: 'data',
    });

    try {
      await this.bills.assertFloatCovers(Money.fromNaira(amountNgn), {
        vertical: 'data',
        phone: opts.phone,
      });
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }

    const ref = `dt_${randomBytes(6).toString('hex')}`;
    const networkLabel = this.networkLabel(opts.network);

    const { stellarTxHash, celoTxHash } = await this.debitCrypto({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      stellarVault,
      celoVault,
      ref,
      product: 'data',
    });
    const cryptoHash = stellarTxHash || celoTxHash || '';

    let purchase;
    try {
      purchase = await this.bills.buyData({
        network: opts.network,
        phoneNumber: opts.recipientPhone,
        planCode: opts.planCode,
        reference: ref,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return this.refundCryptoAfterFailedBill({
        product: 'data',
        chain,
        amountUsdc,
        zyloWallet: opts.zyloWallet,
        phone: opts.phone,
        cryptoHash,
        ref,
        reason,
      });
    }

    const order = purchase.order;
    const orderId = order.providerOrderId || order.reference || ref;
    const rampUser = await this.store.getUser(opts.phone).catch(() => null);

    let receiptPng: Buffer | null = null;
    try {
      receiptPng = await renderAirtimeReceiptPng({
        brandName: config.brandName,
        amountNgn,
        amountUsdc,
        networkLabel: `${networkLabel} data`,
        recipientPhone: opts.recipientPhone,
        ref,
        orderId: String(orderId),
        stellarTxHash: cryptoHash,
        username: rampUser?.username,
        status:
          order.status === BillOrderStatus.Completed
            ? 'completed'
            : isRefundableBillStatus(order.status)
              ? 'failed'
              : 'submitted',
      });
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e), ref },
        '[zylo-ramp] data receipt image failed',
      );
    }

    const statusNote =
      order.status === BillOrderStatus.Completed
        ? 'Data delivered.'
        : isRefundableBillStatus(order.status)
          ? 'Provider refused — support will help with a refund.'
          : 'Data order submitted — usually lands in under a minute.';

    const paidLabel =
      chain === 'celo'
        ? `Paid with ~${formatCeloStable(amountUsdc)} digital dollars (Celo)`
        : `Paid with ~${amountUsdc} USDC (Stellar)`;

    await this.recordBillPurchase({
      ref,
      phone: opts.phone,
      vertical: 'data',
      amountNgn,
      amountUsdc,
      rate,
      productLabel: `${networkLabel} · ${opts.planName}`,
      customerId: opts.recipientPhone,
      status: order.status,
      chain,
      stellarTxHash,
      celoTxHash,
      providerReference: String(orderId),
    });

    return {
      ref,
      amountUsdc,
      amountNgn,
      chain,
      stellarTxHash,
      celoTxHash,
      orderId: String(orderId),
      status: order.status,
      receiptPng,
      message: [
        order.status === BillOrderStatus.Completed ? '✅ Data sent' : '⏳ Data submitted',
        `${opts.planName}`,
        `₦${amountNgn.toLocaleString('en-NG')} ${networkLabel} → ${opts.recipientPhone}`,
        `${paidLabel} (₦${rate}/USDC)`,
        `Ref ${ref}`,
        orderId && orderId !== ref ? `Provider ${orderId}` : '',
        statusNote,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  /** `limit` defaults to the WhatsApp list cap; the web portal asks for everything. */
  async listDiscos(limit = DATA_PLAN_LIST_LIMIT): Promise<
    Array<{
      code: string;
      name: string;
      minNgn: number;
      maxNgn: number;
      meterTypes: MeterType[];
    }>
  > {
    const discos = await this.catalogue.discos();
    return discos.slice(0, limit).map((d) => ({
      code: d.code,
      name: d.name,
      minNgn: moneyToWholeNaira(d.bounds.min),
      maxNgn: moneyToWholeNaira(d.bounds.max),
      meterTypes: d.meterTypes,
    }));
  }

  async listCablePackages(
    provider: CableProvider,
    limit = DATA_PLAN_LIST_LIMIT,
  ): Promise<Array<{ code: string; name: string; amountNgn: number }>> {
    const packages = await this.catalogue.cablePackagesFor(provider);
    return [...packages]
      .sort((a, b) => moneyToWholeNaira(a.costPrice) - moneyToWholeNaira(b.costPrice))
      .slice(0, limit)
      .map((p) => ({
        code: p.code,
        name: p.name,
        amountNgn: moneyToWholeNaira(p.costPrice),
      }));
  }

  async listBettingCompanies(
    limit = DATA_PLAN_LIST_LIMIT,
  ): Promise<Array<{ code: string; name: string; minNgn: number; maxNgn: number }>> {
    const companies = await this.catalogue.bettingCompanies();
    return companies.slice(0, limit).map((c) => ({
      code: c.code,
      name: c.name,
      minNgn: moneyToWholeNaira(c.bounds.min),
      maxNgn: moneyToWholeNaira(c.bounds.max),
    }));
  }

  async verifyMeterName(
    discoCode: string,
    meterNumber: string,
    meterType: MeterType,
  ): Promise<string> {
    try {
      const customer = await this.bills.verifyMeter(discoCode, meterNumber, meterType);
      return customer.name || 'Customer';
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }
  }

  async verifySmartCardName(provider: CableProvider, smartCardNumber: string): Promise<string> {
    try {
      const customer = await this.bills.verifySmartCard(provider, smartCardNumber);
      return customer.name || 'Customer';
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }
  }

  async verifyBettingName(companyCode: string, customerId: string): Promise<string> {
    try {
      const customer = await this.bills.verifyBettingCustomer(companyCode, customerId);
      return customer.name || 'Customer';
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }
  }

  async executeElectricity(opts: {
    phone: string;
    zyloWallet: string;
    discoCode: string;
    discoName: string;
    meterType: MeterType;
    meterNumber: string;
    amountNgn: number;
    customerName?: string;
    chain?: SpendChain;
  }): Promise<{
    ref: string;
    amountUsdc: number;
    amountNgn: number;
    chain: SpendChain;
    status: BillOrderStatus;
    meterToken?: string;
    message: string;
  }> {
    const chain: SpendChain = opts.chain === 'celo' ? 'celo' : 'stellar';
    const amountNgn = Math.round(opts.amountNgn);
    if (amountNgn < 1) throw new Error('Invalid electricity amount.');

    const { amountUsdc, rate } = this.naira.quoteUsdcForNgn(amountNgn);
    if (amountUsdc <= 0) throw new Error('USDC amount too small at current rates.');

    const { stellarVault, celoVault } = await this.assertVaultAndBalance({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      product: 'electricity',
    });

    try {
      await this.bills.assertFloatCovers(Money.fromNaira(amountNgn), {
        vertical: 'electricity',
        phone: opts.phone,
      });
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }

    const ref = `el_${randomBytes(6).toString('hex')}`;
    const { stellarTxHash, celoTxHash } = await this.debitCrypto({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      stellarVault,
      celoVault,
      ref,
      product: 'electricity',
    });
    const cryptoHash = stellarTxHash || celoTxHash || '';

    let purchase;
    try {
      purchase = await this.bills.payElectricity({
        discoCode: opts.discoCode,
        meterType: opts.meterType,
        meterNumber: opts.meterNumber,
        amount: Money.fromNaira(amountNgn),
        phoneNumber: opts.phone,
        reference: ref,
      });
    } catch (e) {
      const raw =
        e instanceof AppException
          ? appExceptionMessage(e)
          : e instanceof Error
            ? e.message
            : String(e);
      return this.refundCryptoAfterFailedBill({
        product: 'electricity',
        chain,
        amountUsdc,
        zyloWallet: opts.zyloWallet,
        phone: opts.phone,
        cryptoHash,
        ref,
        reason: raw,
      });
    }

    const order = purchase.order;
    const paidLabel =
      chain === 'celo'
        ? `Paid with ~${formatCeloStable(amountUsdc)} digital dollars (Celo)`
        : `Paid with ~${amountUsdc} USDC (Stellar)`;
    const tokenLine = order.meterToken ? `Token: *${order.meterToken}*` : '';

    await this.recordBillPurchase({
      ref,
      phone: opts.phone,
      vertical: 'electricity',
      amountNgn,
      amountUsdc,
      rate,
      productLabel: opts.discoName,
      customerId: opts.meterNumber,
      customerName: opts.customerName,
      status: order.status,
      chain,
      stellarTxHash,
      celoTxHash,
      providerReference: order.providerOrderId || order.reference || ref,
    });

    return {
      ref,
      amountUsdc,
      amountNgn,
      chain,
      status: order.status,
      meterToken: order.meterToken,
      message: [
        order.status === BillOrderStatus.Completed
          ? '✅ Electricity paid'
          : '⏳ Electricity submitted',
        `${opts.discoName} · meter ${opts.meterNumber}`,
        opts.customerName ? `Name: ${opts.customerName}` : '',
        `₦${amountNgn.toLocaleString('en-NG')}`,
        tokenLine,
        `${paidLabel} (₦${rate}/USDC)`,
        `Ref ${ref}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  async executeCable(opts: {
    phone: string;
    zyloWallet: string;
    provider: CableProvider;
    providerLabel: string;
    packageCode: string;
    packageName: string;
    smartCardNumber: string;
    amountNgn: number;
    customerName?: string;
    chain?: SpendChain;
  }): Promise<{
    ref: string;
    amountUsdc: number;
    amountNgn: number;
    chain: SpendChain;
    status: BillOrderStatus;
    message: string;
  }> {
    const chain: SpendChain = opts.chain === 'celo' ? 'celo' : 'stellar';
    const amountNgn = Math.round(opts.amountNgn);
    if (amountNgn < 1) throw new Error('Invalid cable package price.');

    const { amountUsdc, rate } = this.naira.quoteUsdcForNgn(amountNgn);
    if (amountUsdc <= 0) throw new Error('USDC amount too small at current rates.');

    const { stellarVault, celoVault } = await this.assertVaultAndBalance({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      product: 'cable',
    });

    try {
      await this.bills.assertFloatCovers(Money.fromNaira(amountNgn), {
        vertical: 'cable_tv',
        phone: opts.phone,
      });
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }

    const ref = `tv_${randomBytes(6).toString('hex')}`;
    const { stellarTxHash, celoTxHash } = await this.debitCrypto({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      stellarVault,
      celoVault,
      ref,
      product: 'cable',
    });
    const cryptoHash = stellarTxHash || celoTxHash || '';

    let purchase;
    try {
      purchase = await this.bills.subscribeCableTv({
        provider: opts.provider,
        packageCode: opts.packageCode,
        smartCardNumber: opts.smartCardNumber,
        phoneNumber: opts.phone,
        reference: ref,
      });
    } catch (e) {
      const raw =
        e instanceof AppException
          ? appExceptionMessage(e)
          : e instanceof Error
            ? e.message
            : String(e);
      return this.refundCryptoAfterFailedBill({
        product: 'cable',
        chain,
        amountUsdc,
        zyloWallet: opts.zyloWallet,
        phone: opts.phone,
        cryptoHash,
        ref,
        reason: raw,
      });
    }

    const order = purchase.order;
    const paidLabel =
      chain === 'celo'
        ? `Paid with ~${formatCeloStable(amountUsdc)} digital dollars (Celo)`
        : `Paid with ~${amountUsdc} USDC (Stellar)`;

    await this.recordBillPurchase({
      ref,
      phone: opts.phone,
      vertical: 'cable',
      amountNgn,
      amountUsdc,
      rate,
      productLabel: `${opts.providerLabel} · ${opts.packageName}`,
      customerId: opts.smartCardNumber,
      customerName: opts.customerName,
      status: order.status,
      chain,
      stellarTxHash,
      celoTxHash,
      providerReference: order.providerOrderId || order.reference || ref,
    });

    return {
      ref,
      amountUsdc,
      amountNgn,
      chain,
      status: order.status,
      message: [
        order.status === BillOrderStatus.Completed ? '✅ TV subscription paid' : '⏳ TV submitted',
        `${opts.providerLabel} · ${opts.packageName}`,
        `Smartcard ${opts.smartCardNumber}`,
        opts.customerName ? `Name: ${opts.customerName}` : '',
        `₦${amountNgn.toLocaleString('en-NG')}`,
        `${paidLabel} (₦${rate}/USDC)`,
        `Ref ${ref}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  async executeBetting(opts: {
    phone: string;
    zyloWallet: string;
    companyCode: string;
    companyName: string;
    customerId: string;
    amountNgn: number;
    customerName?: string;
    chain?: SpendChain;
  }): Promise<{
    ref: string;
    amountUsdc: number;
    amountNgn: number;
    chain: SpendChain;
    status: BillOrderStatus;
    message: string;
  }> {
    const chain: SpendChain = opts.chain === 'celo' ? 'celo' : 'stellar';
    const amountNgn = Math.round(opts.amountNgn);
    if (amountNgn < 1) throw new Error('Invalid betting amount.');

    const { amountUsdc, rate } = this.naira.quoteUsdcForNgn(amountNgn);
    if (amountUsdc <= 0) throw new Error('USDC amount too small at current rates.');

    const { stellarVault, celoVault } = await this.assertVaultAndBalance({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      product: 'betting',
    });

    try {
      await this.bills.assertFloatCovers(Money.fromNaira(amountNgn), {
        vertical: 'betting',
        phone: opts.phone,
      });
    } catch (e) {
      if (e instanceof AppException) throw new Error(appExceptionMessage(e));
      throw e;
    }

    const ref = `bt_${randomBytes(6).toString('hex')}`;
    const { stellarTxHash, celoTxHash } = await this.debitCrypto({
      phone: opts.phone,
      zyloWallet: opts.zyloWallet,
      chain,
      amountUsdc,
      stellarVault,
      celoVault,
      ref,
      product: 'betting',
    });
    const cryptoHash = stellarTxHash || celoTxHash || '';

    let purchase;
    try {
      purchase = await this.bills.fundBetting({
        companyCode: opts.companyCode,
        customerId: opts.customerId,
        amount: Money.fromNaira(amountNgn),
        reference: ref,
      });
    } catch (e) {
      const raw =
        e instanceof AppException
          ? appExceptionMessage(e)
          : e instanceof Error
            ? e.message
            : String(e);
      return this.refundCryptoAfterFailedBill({
        product: 'betting',
        chain,
        amountUsdc,
        zyloWallet: opts.zyloWallet,
        phone: opts.phone,
        cryptoHash,
        ref,
        reason: raw,
      });
    }

    const order = purchase.order;
    const paidLabel =
      chain === 'celo'
        ? `Paid with ~${formatCeloStable(amountUsdc)} digital dollars (Celo)`
        : `Paid with ~${amountUsdc} USDC (Stellar)`;

    await this.recordBillPurchase({
      ref,
      phone: opts.phone,
      vertical: 'betting',
      amountNgn,
      amountUsdc,
      rate,
      productLabel: opts.companyName,
      customerId: opts.customerId,
      customerName: opts.customerName,
      status: order.status,
      chain,
      stellarTxHash,
      celoTxHash,
      providerReference: order.providerOrderId || order.reference || ref,
    });

    return {
      ref,
      amountUsdc,
      amountNgn,
      chain,
      status: order.status,
      message: [
        order.status === BillOrderStatus.Completed
          ? '✅ Betting wallet funded'
          : '⏳ Betting submitted',
        `${opts.companyName} · ID ${opts.customerId}`,
        opts.customerName ? `Name: ${opts.customerName}` : '',
        `₦${amountNgn.toLocaleString('en-NG')}`,
        `${paidLabel} (₦${rate}/USDC)`,
        `Ref ${ref}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}
