import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Phone } from '../../core/utils/phone.util';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { AuthService, type DeviceContext } from '../auth/auth.service';
import { RewardsService } from '../rewards/rewards.service';
import {
  BillOrderStatus,
  CableProvider,
  MeterType,
  MobileNetwork,
} from '../bills/bills-provider.interface';
import type {
  AirtimeDto,
  BankSendDto,
  BettingDto,
  CableDto,
  DataDto,
  ElectricityDto,
  PortalCableProvider,
  PortalMeterType,
  PortalMobileNetwork,
  PortalNetwork,
  SellUsdcDto,
  SendUsdcDto,
} from './dto/portal-actions.dto';
import { RampBillsService } from './ramp.bills';
import { RampCeloWalletService } from './ramp.celo-wallet';
import { RampCommandsService, type TransferDestCandidate } from './ramp.commands';
import { getRampConfig } from './ramp.config';
import { celoTxUrl, stellarTxUrl } from './ramp.format';
import { RampNairaService } from './ramp.naira';
import { OutcomeUnknownError, RampPortalIdempotency } from './ramp-portal.idempotency';
import { RampStellarWalletService } from './ramp.stellar-wallet';
import { RampStoreService } from './ramp.store';
import { RampWhatsAppService } from './ramp.whatsapp';
import {
  renderBankSendReceiptPng,
  renderBillReceiptPng,
  renderTransferReceiptPng,
} from './ramp.receipt';

const MOBILE_NETWORKS: Record<PortalMobileNetwork, MobileNetwork> = {
  mtn: MobileNetwork.Mtn,
  airtel: MobileNetwork.Airtel,
  glo: MobileNetwork.Glo,
  '9mobile': MobileNetwork.NineMobile,
};

const METER_TYPES: Record<PortalMeterType, MeterType> = {
  prepaid: MeterType.Prepaid,
  postpaid: MeterType.Postpaid,
};

const CABLE_PROVIDERS: Record<PortalCableProvider, { id: CableProvider; label: string }> = {
  dstv: { id: CableProvider.Dstv, label: 'DStv' },
  gotv: { id: CableProvider.Gotv, label: 'GOtv' },
  startimes: { id: CableProvider.Startimes, label: 'StarTimes' },
  showmax: { id: CableProvider.Showmax, label: 'Showmax' },
};

/** Fallback funding bounds when the catalogue reports none (matches the WhatsApp flow). */
const BETTING_DEFAULT_BOUNDS = { minNgn: 100, maxNgn: 50_000 };
const ELECTRICITY_DEFAULT_BOUNDS = { minNgn: 1_000, maxNgn: 200_000 };

/** The catalogue is short; the portal shows all of it rather than the WhatsApp list cap. */
const NO_LIST_LIMIT = Number.MAX_SAFE_INTEGER;

export type PortalTxStatus = 'completed' | 'processing' | 'failed';

export type PortalBillVertical = 'electricity' | 'cable' | 'betting';

export interface PortalUtilityResult {
  ref: string;
  status: PortalTxStatus;
  vertical: PortalBillVertical;
  amountNgn: number;
  amountUsdc: number;
  network: PortalNetwork;
  /** Disco, "DStv · Compact" or betting company. */
  productLabel: string;
  /** Meter, smartcard or betting customer id. */
  customerId: string;
  customerName: string;
  /** Prepaid electricity only, when the provider returns it straight away. */
  meterToken: string | null;
}

export interface PortalRecipient {
  address: string;
  label: string;
  displayName: string | null;
  kind: TransferDestCandidate['kind'];
  knownUser: boolean;
}

/**
 * Money movement from the web portal.
 *
 * Every action runs the same service calls the WhatsApp chat runs — transfers,
 * bank sends, sells and bills — so limits, rates, vault handling, refunds and
 * receipts behave identically. This layer adds what a web API needs and a chat
 * does not: server-side PIN verification with lockout, idempotency, and never
 * trusting a price, account name or rate sent by the client.
 */
@Injectable()
export class RampPortalActionsService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly auth: AuthService,
    private readonly idempotency: RampPortalIdempotency,
    private readonly commands: RampCommandsService,
    private readonly naira: RampNairaService,
    private readonly bills: RampBillsService,
    private readonly stellar: RampStellarWalletService,
    private readonly celo: RampCeloWalletService,
    private readonly store: RampStoreService,
    private readonly rewards: RewardsService,
    private readonly whatsapp: RampWhatsAppService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RampPortalActionsService.name);
  }

  // ── Lookups ────────────────────────────────────────────────────────────────

  async resolveRecipients(
    userId: string,
    query: string,
    network: PortalNetwork,
  ): Promise<PortalRecipient[]> {
    const phone = await this.rampPhone(userId);
    const result =
      network === 'celo'
        ? await this.commands.resolveCeloTransferDestination(phone, query)
        : await this.commands.resolveTransferDestination(phone, query);
    if ('error' in result) {
      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, { message: result.error });
    }
    return result.matches.map((m) => ({
      address: m.to,
      label: m.toLabel,
      displayName: m.displayName ?? null,
      kind: m.kind,
      knownUser: m.knownUser,
    }));
  }

  quoteBankSend(amountNgn: number) {
    const config = getRampConfig();
    this.assertBankSendLimits(amountNgn);
    const quote = this.naira.quoteUsdcForNgn(amountNgn);
    return {
      amountNgn: quote.amountNgn,
      amountUsdc: quote.amountUsdc,
      rateNgn: quote.rate,
      minNgn: config.minBankSendNgn,
      maxNgn: config.maxBankSendNgn,
    };
  }

  async listDataPlans(network: PortalMobileNetwork) {
    try {
      const plans = await this.bills.listDataPlansForNetwork(MOBILE_NETWORKS[network]);
      return plans.map((p) => ({ code: p.code, name: p.name, amountNgn: p.amountNgn }));
    } catch (e) {
      throw this.toPortalError(e, 'data-plans');
    }
  }

  async listDiscos() {
    try {
      const discos = await this.bills.listDiscos(NO_LIST_LIMIT);
      return discos.map((d) => {
        const bounds = this.electricityBounds(d);
        return {
          code: d.code,
          name: d.name,
          minNgn: bounds.minNgn,
          maxNgn: bounds.maxNgn,
          meterTypes: (d.meterTypes.length
            ? d.meterTypes
            : [MeterType.Prepaid, MeterType.Postpaid]
          ).map((t) => (t === MeterType.Postpaid ? 'postpaid' : 'prepaid')),
        };
      });
    } catch (e) {
      throw this.toPortalError(e, 'discos');
    }
  }

  async listCablePackages(provider: PortalCableProvider) {
    try {
      return await this.bills.listCablePackages(CABLE_PROVIDERS[provider].id, NO_LIST_LIMIT);
    } catch (e) {
      throw this.toPortalError(e, 'cable-packages');
    }
  }

  async listBettingCompanies() {
    try {
      const companies = await this.bills.listBettingCompanies(NO_LIST_LIMIT);
      return companies.map((c) => ({ code: c.code, name: c.name, ...this.bettingBounds(c) }));
    } catch (e) {
      throw this.toPortalError(e, 'betting-companies');
    }
  }

  /**
   * The name the provider holds for a meter, smartcard or betting id. Shown
   * before paying because none of these payments can be reversed.
   */
  async verifyMeter(discoCode: string, meterType: PortalMeterType, meterNumber: string) {
    const disco = await this.requireDisco(discoCode);
    return {
      name: await this.verifiedName('meter', () =>
        this.bills.verifyMeterName(disco.code, meterNumber, METER_TYPES[meterType]),
      ),
    };
  }

  async verifySmartCard(provider: PortalCableProvider, smartCardNumber: string) {
    return {
      name: await this.verifiedName('smartcard', () =>
        this.bills.verifySmartCardName(CABLE_PROVIDERS[provider].id, smartCardNumber),
      ),
    };
  }

  async verifyBettingCustomer(companyCode: string, customerId: string) {
    const company = await this.requireBettingCompany(companyCode);
    return {
      name: await this.verifiedName('betting', () =>
        this.bills.verifyBettingName(company.code, customerId),
      ),
    };
  }

  async getBankSend(userId: string, ref: string) {
    const phone = await this.rampPhone(userId);
    const send = await this.store.findBankSendByRef(ref);
    // Scoped to the caller: another customer's reference is simply not found.
    if (!send || !this.samePhone(send.phone, phone)) {
      throw AppException.notFound('Bank transfer', ref);
    }
    return {
      ref: send.ref,
      status: this.bankSendStatus(send.status),
      amountNgn: send.amountNgn,
      amountUsdc: Number(send.amountUsdc),
      bankName: send.bankName,
      accountName: send.accountName,
      accountNumber: send.accountNumber,
    };
  }

  /** Newest bank sends for this customer — used when the POST body lost its ref. */
  async listRecentBankSends(userId: string, limit = 10) {
    const phone = await this.rampPhone(userId);
    const rows = await this.store.listRecentBankSendsForPhone(phone, limit);
    return rows.map((send) => ({
      ref: send.ref,
      status: this.bankSendStatus(send.status),
      amountNgn: send.amountNgn,
      amountUsdc: send.amountUsdc,
      bankName: send.bankName,
      accountName: send.accountName,
      accountNumber: send.accountNumber,
      createdAt: send.createdAt.toISOString(),
    }));
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async sendUsdc(userId: string, dto: SendUsdcDto, key: string | undefined, device: DeviceContext) {
    const amount = this.parseUsdc(dto.amount);
    return this.guarded('usdc-transfer', userId, key, { ...dto, pin: undefined }, async () => {
      await this.auth.verifyTransactionPin(userId, dto.pin, device);
      const phone = await this.rampPhone(userId);
      const config = getRampConfig();
      if (amount > config.maxOrderUsdc) {
        throw this.invalid(`The most you can send at once is ${config.maxOrderUsdc} USDC.`);
      }

      const [recipient, ...others] = await this.resolveRecipients(
        userId,
        dto.recipient,
        dto.network,
      );
      if (!recipient || others.length > 0) {
        throw this.invalid(
          'More than one recipient matches. Use their exact @username or address.',
        );
      }

      const fromWallet =
        dto.network === 'celo'
          ? await this.commands.ensureCeloWallet(phone)
          : await this.commands.ensureZyloWallet(phone);
      if (!fromWallet) {
        throw new AppException(ErrorCode.PRECONDITION_FAILED, {
          message: 'Your wallet on this network is not ready yet.',
        });
      }
      if (this.sameAddress(fromWallet, recipient.address)) {
        throw this.invalid("You can't send to your own wallet.");
      }

      let txHash: string;
      let sentSymbol: string | undefined;
      try {
        if (dto.network === 'celo') {
          const sent = await this.celo.transferStable({ phone, to: recipient.address, amount });
          txHash = sent.txHash;
          sentSymbol = sent.symbol === 'cUSD' ? 'cUSD' : sent.symbol;
        } else {
          txHash = await this.stellar.transferUsdc(fromWallet, recipient.address, amount, phone);
        }
      } catch (e) {
        throw this.toPortalError(e, 'usdc-transfer');
      }

      const user = await this.store.getUser(phone).catch(() => null);
      void this.commands.notifyRecipientTransfer({
        senderPhone: phone,
        senderUsername: user?.username,
        senderWhatsappName: user?.whatsappName,
        fromWallet,
        toWallet: recipient.address,
        toLabel: recipient.label,
        amount,
        asset: dto.network === 'celo' ? 'celo' : 'usdc',
        hash: txHash,
        sentSymbol,
      });

      void this.notifyPortalUsdcSend(phone, {
        amount,
        toLabel: recipient.label,
        toAddress: recipient.address,
        txHash,
        network: dto.network,
        sentSymbol,
        username: user?.username,
      });

      this.logger.info({ userId, network: dto.network, amount }, 'Portal USDC transfer sent');
      return {
        status: 'completed' as PortalTxStatus,
        amountUsdc: amount,
        network: dto.network,
        recipient: { label: recipient.label, address: recipient.address },
        txHash,
        txUrl: dto.network === 'celo' ? celoTxUrl(txHash) : stellarTxUrl(txHash),
      };
    });
  }

  async bankSend(userId: string, dto: BankSendDto, key: string | undefined, device: DeviceContext) {
    const amountNgn = Number(dto.amountNgn);
    return this.guarded('bank-send', userId, key, { ...dto, pin: undefined }, async () => {
      this.assertBankSendLimits(amountNgn);
      await this.auth.verifyTransactionPin(userId, dto.pin, device);
      const phone = await this.rampPhone(userId);

      const wallet = await this.spendWallet(phone, dto.network);
      // Never trust a name from the client: resolve it here, as the chat does.
      const account = await this.resolveAccount(dto.accountNumber, dto.bankCode);
      const bank = await this.naira.resolveSupportedBank(dto.bankCode, '').catch((e: unknown) => {
        throw this.toPortalError(e, 'bank-send');
      });
      const bankName = bank.name;

      const result = await this.executeBankSend({
        phone,
        zyloWallet: wallet,
        amountNgn,
        bankCode: bank.code,
        bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        chain: dto.network,
      });

      await this.savePayoutAccount(phone, {
        bankCode: bank.code,
        bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
      });

      // Money has already moved — never await WhatsApp here. Awaiting Meta (or a
      // hung notify) timed out the browser and showed "Couldn't confirm" after a
      // successful sell/send. Start the notify now so the event loop keeps it,
      // then return the success body immediately.
      void this.notifyPortalBankOutcome(phone, result, 'bank-send', {
        accountName: account.accountName,
        bankName,
        accountNumber: account.accountNumber,
      }).catch((err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Portal bank-send WhatsApp notify failed',
        );
      });

      const ref = String(result.ref || '').trim();
      return {
        ref,
        reference: ref,
        message: result.message ?? undefined,
        status: (result.completed ? 'completed' : 'processing') as PortalTxStatus,
        amountNgn: result.amountNgn,
        amountUsdc: result.amountUsdc,
        network: result.chain,
        accountName: account.accountName,
        bankName,
        accountNumber: account.accountNumber,
      };
    });
  }

  async sellUsdc(userId: string, dto: SellUsdcDto, key: string | undefined, device: DeviceContext) {
    const amountUsdc = this.parseUsdc(dto.amountUsdc);
    return this.guarded('sell', userId, key, { ...dto, pin: undefined }, async () => {
      const config = getRampConfig();
      if (dto.quotedRateNgn !== config.rates.sellNgn) {
        throw new AppException(ErrorCode.PRECONDITION_FAILED, {
          message: 'The rate has changed. Review the new quote before selling.',
          details: { rateNgn: config.rates.sellNgn },
        });
      }
      if (amountUsdc > config.maxOrderUsdc) {
        throw this.invalid(`The most you can sell at once is ${config.maxOrderUsdc} USDC.`);
      }
      // Same quote as the chat's buildSellQuote.
      const rate = config.rates.sellNgn;
      const gross = Math.round(amountUsdc * rate);
      const fee = Math.max(0, config.sellFeeNgn);
      const payout = Math.max(0, gross - fee);
      if (payout < config.minBankSendNgn) {
        throw this.invalid(
          `That sale pays out less than the ₦${config.minBankSendNgn.toLocaleString('en-NG')} minimum. Sell a larger amount.`,
        );
      }

      await this.auth.verifyTransactionPin(userId, dto.pin, device);
      const phone = await this.rampPhone(userId);
      const payoutAccount = await this.payoutAccountFor(phone, dto.payoutAccountId);
      const wallet = await this.spendWallet(phone, dto.network);
      const bank = await this.naira
        .resolveSupportedBank(payoutAccount.bankCode, payoutAccount.bankName)
        .catch((e: unknown) => {
          throw this.toPortalError(e, 'sell');
        });

      const result = await this.executeBankSend({
        phone,
        zyloWallet: wallet,
        amountNgn: payout,
        amountUsdc,
        rate,
        bankCode: bank.code,
        bankName: bank.name,
        accountNumber: payoutAccount.accountNumber,
        accountName: payoutAccount.accountName,
        chain: dto.network,
      });

      void this.notifyPortalBankOutcome(phone, result, 'sell', {
        accountName: payoutAccount.accountName,
        bankName: bank.name,
        accountNumber: payoutAccount.accountNumber,
      }).catch((err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Portal sell WhatsApp notify failed',
        );
      });

      const ref = String(result.ref || '').trim();
      return {
        ref,
        reference: ref,
        message: result.message ?? undefined,
        status: (result.completed ? 'completed' : 'processing') as PortalTxStatus,
        amountUsdc: result.amountUsdc,
        rateNgn: rate,
        feeNgn: fee,
        payoutNgn: result.amountNgn,
        network: result.chain,
        accountName: payoutAccount.accountName,
        bankName: bank.name,
        accountNumber: payoutAccount.accountNumber,
      };
    });
  }

  async buyAirtime(
    userId: string,
    dto: AirtimeDto,
    key: string | undefined,
    device: DeviceContext,
  ) {
    return this.guarded('airtime', userId, key, { ...dto, pin: undefined }, async () => {
      await this.auth.verifyTransactionPin(userId, dto.pin, device);
      const phone = await this.rampPhone(userId);
      const wallet = await this.spendWallet(phone, dto.network);
      try {
        const result = await this.bills.executeAirtime({
          phone,
          zyloWallet: wallet,
          network: MOBILE_NETWORKS[dto.mobileNetwork],
          recipientPhone: dto.phone,
          amountNgn: Number(dto.amountNgn),
          chain: dto.network,
        });
        void this.notifyPortalBillOutcome(phone, result, {
          filename: 'banjee-airtime-receipt.png',
          headline: 'Airtime sent',
          rows: [
            { label: 'Network', value: dto.mobileNetwork.toUpperCase() },
            { label: 'To', value: dto.phone },
          ],
        });
        return this.billResult(result, { phone: dto.phone, mobileNetwork: dto.mobileNetwork });
      } catch (e) {
        throw this.toPortalError(e, 'airtime');
      }
    });
  }

  async buyData(userId: string, dto: DataDto, key: string | undefined, device: DeviceContext) {
    return this.guarded('data', userId, key, { ...dto, pin: undefined }, async () => {
      // Price comes from the provider catalogue, never from the client.
      const plans = await this.listDataPlans(dto.mobileNetwork);
      const plan = plans.find((p) => p.code === dto.planCode);
      if (!plan) {
        throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
          message: 'That data plan is no longer available. Choose another.',
        });
      }
      await this.auth.verifyTransactionPin(userId, dto.pin, device);
      const phone = await this.rampPhone(userId);
      const wallet = await this.spendWallet(phone, dto.network);
      try {
        const result = await this.bills.executeData({
          phone,
          zyloWallet: wallet,
          network: MOBILE_NETWORKS[dto.mobileNetwork],
          recipientPhone: dto.phone,
          planCode: plan.code,
          planName: plan.name,
          amountNgn: plan.amountNgn,
          chain: dto.network,
        });
        void this.notifyPortalBillOutcome(phone, result, {
          filename: 'banjee-data-receipt.png',
          headline: 'Data sent',
          rows: [
            { label: 'Network', value: dto.mobileNetwork.toUpperCase() },
            { label: 'Plan', value: plan.name },
            { label: 'To', value: dto.phone },
          ],
        });
        return {
          ...this.billResult(result, { phone: dto.phone, mobileNetwork: dto.mobileNetwork }),
          planName: plan.name,
        };
      } catch (e) {
        throw this.toPortalError(e, 'data');
      }
    });
  }

  async payElectricity(
    userId: string,
    dto: ElectricityDto,
    key: string | undefined,
    device: DeviceContext,
  ): Promise<PortalUtilityResult> {
    return this.guarded('electricity', userId, key, { ...dto, pin: undefined }, async () => {
      const disco = await this.requireDisco(dto.discoCode);
      const amountNgn = Number(dto.amountNgn);
      const bounds = this.electricityBounds(disco);
      this.assertBillAmount(amountNgn, bounds);
      await this.auth.verifyTransactionPin(userId, dto.pin, device);

      // The name on the receipt comes from the provider, never from the client.
      const customerName = await this.verifiedName('meter', () =>
        this.bills.verifyMeterName(disco.code, dto.meterNumber, METER_TYPES[dto.meterType]),
      );
      const phone = await this.rampPhone(userId);
      const wallet = await this.spendWallet(phone, dto.network);
      try {
        const result = await this.bills.executeElectricity({
          phone,
          zyloWallet: wallet,
          discoCode: disco.code,
          discoName: disco.name,
          meterType: METER_TYPES[dto.meterType],
          meterNumber: dto.meterNumber,
          amountNgn,
          customerName,
          chain: dto.network,
        });
        void this.notifyPortalBillOutcome(phone, result, {
          filename: 'banjee-electricity-receipt.png',
          headline: 'Electricity paid',
          rows: [
            { label: 'Disco', value: disco.name },
            { label: 'Meter', value: dto.meterNumber },
            ...(customerName ? [{ label: 'Name', value: customerName }] : []),
            ...(result.meterToken ? [{ label: 'Token', value: result.meterToken }] : []),
          ],
        });
        return {
          ...this.utilityResult(result, 'electricity'),
          productLabel: `${disco.name} · ${dto.meterType === 'prepaid' ? 'Prepaid' : 'Postpaid'}`,
          customerId: dto.meterNumber,
          customerName,
          meterToken: result.meterToken ?? null,
        };
      } catch (e) {
        throw this.toPortalError(e, 'electricity');
      }
    });
  }

  async payCable(
    userId: string,
    dto: CableDto,
    key: string | undefined,
    device: DeviceContext,
  ): Promise<PortalUtilityResult> {
    return this.guarded('cable', userId, key, { ...dto, pin: undefined }, async () => {
      const provider = CABLE_PROVIDERS[dto.provider];
      // Price comes from the provider catalogue, never from the client.
      const packages = await this.listCablePackages(dto.provider);
      const pkg = packages.find((p) => p.code === dto.packageCode);
      if (!pkg) {
        throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
          message: 'That TV package is no longer available. Choose another.',
        });
      }
      await this.auth.verifyTransactionPin(userId, dto.pin, device);
      const customerName = await this.verifiedName('smartcard', () =>
        this.bills.verifySmartCardName(provider.id, dto.smartCardNumber),
      );
      const phone = await this.rampPhone(userId);
      const wallet = await this.spendWallet(phone, dto.network);
      try {
        const result = await this.bills.executeCable({
          phone,
          zyloWallet: wallet,
          provider: provider.id,
          providerLabel: provider.label,
          packageCode: pkg.code,
          packageName: pkg.name,
          smartCardNumber: dto.smartCardNumber,
          amountNgn: pkg.amountNgn,
          customerName,
          chain: dto.network,
        });
        void this.notifyPortalBillOutcome(phone, result, {
          filename: 'banjee-cable-receipt.png',
          headline: 'TV subscription paid',
          rows: [
            { label: 'Provider', value: provider.label },
            { label: 'Package', value: pkg.name },
            { label: 'Smartcard', value: dto.smartCardNumber },
            ...(customerName ? [{ label: 'Name', value: customerName }] : []),
          ],
        });
        return {
          ...this.utilityResult(result, 'cable'),
          productLabel: `${provider.label} · ${pkg.name}`,
          customerId: dto.smartCardNumber,
          customerName,
          meterToken: null,
        };
      } catch (e) {
        throw this.toPortalError(e, 'cable');
      }
    });
  }

  async fundBetting(
    userId: string,
    dto: BettingDto,
    key: string | undefined,
    device: DeviceContext,
  ): Promise<PortalUtilityResult> {
    return this.guarded('betting', userId, key, { ...dto, pin: undefined }, async () => {
      const company = await this.requireBettingCompany(dto.companyCode);
      const amountNgn = Number(dto.amountNgn);
      this.assertBillAmount(amountNgn, this.bettingBounds(company));
      await this.auth.verifyTransactionPin(userId, dto.pin, device);
      const customerName = await this.verifiedName('betting', () =>
        this.bills.verifyBettingName(company.code, dto.customerId),
      );
      const phone = await this.rampPhone(userId);
      const wallet = await this.spendWallet(phone, dto.network);
      try {
        const result = await this.bills.executeBetting({
          phone,
          zyloWallet: wallet,
          companyCode: company.code,
          companyName: company.name,
          customerId: dto.customerId,
          amountNgn,
          customerName,
          chain: dto.network,
        });
        void this.notifyPortalBillOutcome(phone, result, {
          filename: 'banjee-betting-receipt.png',
          headline: 'Betting wallet funded',
          rows: [
            { label: 'Platform', value: company.name },
            { label: 'Customer ID', value: dto.customerId },
            ...(customerName ? [{ label: 'Name', value: customerName }] : []),
          ],
        });
        return {
          ...this.utilityResult(result, 'betting'),
          productLabel: company.name,
          customerId: dto.customerId,
          customerName,
          meterToken: null,
        };
      } catch (e) {
        throw this.toPortalError(e, 'betting');
      }
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async requireDisco(code: string) {
    const discos = await this.bills.listDiscos(NO_LIST_LIMIT).catch((e: unknown) => {
      throw this.toPortalError(e, 'discos');
    });
    const disco = discos.find((d) => d.code === code);
    if (!disco) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That electricity company is not available right now. Choose another.',
      });
    }
    return disco;
  }

  private async requireBettingCompany(code: string) {
    const companies = await this.bills.listBettingCompanies(NO_LIST_LIMIT).catch((e: unknown) => {
      throw this.toPortalError(e, 'betting-companies');
    });
    const company = companies.find((c) => c.code === code);
    if (!company) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That betting platform is not available right now. Choose another.',
      });
    }
    return company;
  }

  private electricityBounds(d: { minNgn: number; maxNgn: number }) {
    return {
      minNgn: d.minNgn > 0 ? d.minNgn : ELECTRICITY_DEFAULT_BOUNDS.minNgn,
      maxNgn: d.maxNgn > 0 ? d.maxNgn : ELECTRICITY_DEFAULT_BOUNDS.maxNgn,
    };
  }

  private bettingBounds(c: { minNgn: number; maxNgn: number }) {
    return {
      minNgn: c.minNgn > 0 ? c.minNgn : BETTING_DEFAULT_BOUNDS.minNgn,
      maxNgn: c.maxNgn > 0 ? c.maxNgn : BETTING_DEFAULT_BOUNDS.maxNgn,
    };
  }

  private assertBillAmount(amountNgn: number, bounds: { minNgn: number; maxNgn: number }) {
    if (!Number.isInteger(amountNgn) || amountNgn < bounds.minNgn || amountNgn > bounds.maxNgn) {
      throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
        message: `Enter an amount between ₦${bounds.minNgn.toLocaleString('en-NG')} and ₦${bounds.maxNgn.toLocaleString('en-NG')}.`,
        details: { minimum: String(bounds.minNgn), maximum: String(bounds.maxNgn) },
      });
    }
  }

  /** Runs a provider name lookup, turning "not found" into a clear customer error. */
  private async verifiedName(
    kind: 'meter' | 'smartcard' | 'betting',
    lookup: () => Promise<string>,
  ): Promise<string> {
    try {
      return await lookup();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn({ err: message, kind }, 'Bill customer lookup failed');
      if (/not configured|not set|unavailable|timeout|timed out|econn/i.test(message)) {
        throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
          message: "We can't check this right now. Try again shortly.",
        });
      }
      const what =
        kind === 'meter'
          ? 'that meter number'
          : kind === 'smartcard'
            ? 'that smartcard / IUC number'
            : 'that betting account ID';
      throw new AppException(ErrorCode.BILL_CUSTOMER_INVALID, {
        message: `We couldn't find ${what}. Check it and try again.`,
      });
    }
  }

  private utilityResult(
    result: {
      ref: string;
      status: BillOrderStatus;
      amountNgn: number;
      amountUsdc: number;
      chain: PortalNetwork;
    },
    vertical: PortalBillVertical,
  ) {
    const status: PortalTxStatus =
      result.status === BillOrderStatus.Completed
        ? 'completed'
        : result.status === BillOrderStatus.Failed
          ? 'failed'
          : 'processing';
    return {
      ref: result.ref,
      status,
      vertical,
      amountNgn: result.amountNgn,
      amountUsdc: result.amountUsdc,
      network: result.chain,
    };
  }

  /** Idempotency wrapper that turns an unknown outcome into a clear API error. */
  private async guarded<T extends object>(
    endpoint: string,
    userId: string,
    key: string | undefined,
    request: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await this.idempotency.run({ key, endpoint, userId, request }, action);
      // Milestones and referral qualification. Settles in the background: points
      // must never slow down or fail a money movement.
      void this.rewards.onTransaction(userId);
      return result;
    } catch (e) {
      if (e instanceof OutcomeUnknownError) {
        throw new AppException(ErrorCode.PAYOUT_UNKNOWN_OUTCOME, {
          message:
            "This was submitted but we couldn't confirm it yet. Check your balance and Activity before trying again.",
        });
      }
      throw e;
    }
  }

  private async executeBankSend(opts: Parameters<RampNairaService['executeBankSend']>[0]) {
    try {
      // Never wait on FalconPay settlement in the HTTP request — that times out
      // the web app after USDC has already left and shows a false failure.
      return await this.naira.executeBankSend({ ...opts, deferSettlement: true });
    } catch (e) {
      throw this.toPortalError(e, 'bank-send');
    }
  }

  /**
   * Always send a text update; attach the green receipt image when available.
   * Callers must not await this after money has moved — WhatsApp latency must
   * not hold the web response (that caused false "Couldn't confirm" errors).
   */
  private async notifyPortalBankOutcome(
    phone: string,
    result: Awaited<ReturnType<RampNairaService['executeBankSend']>>,
    kind: 'bank-send' | 'sell',
    account: { accountName: string; bankName: string; accountNumber: string },
  ): Promise<void> {
    const filename = kind === 'sell' ? 'banjee-sale-receipt.png' : 'banjee-bank-receipt.png';
    const text =
      result.message?.trim() ||
      (result.completed
        ? [
            kind === 'sell'
              ? '✅ Sale completed from the web app'
              : '✅ Bank transfer completed from the web app',
            `₦${result.amountNgn.toLocaleString('en-NG')} → ${account.accountName}`,
            `${account.bankName} · ${account.accountNumber}`,
            `Ref ${result.ref}`,
          ].join('\n')
        : [
            kind === 'sell'
              ? '⏳ Sale submitted from the web app'
              : '⏳ Bank transfer submitted from the web app',
            `₦${result.amountNgn.toLocaleString('en-NG')} → ${account.accountName}`,
            `${account.bankName} · ${account.accountNumber}`,
            `Ref ${result.ref}`,
            '',
            'You will get a green receipt on WhatsApp when the payment clears.',
          ].join('\n'));

    // Text first so the user always gets an update even if media upload fails.
    await this.notifyPortalWhatsApp(phone, text);

    let receiptPng = result.receiptPng ?? null;
    let caption = result.message?.trim() || text;

    if (result.completed && !receiptPng) {
      try {
        const rampUser = await this.store.getUser(phone).catch(() => null);
        receiptPng = await renderBankSendReceiptPng({
          brandName: getRampConfig().brandName,
          amountNgn: result.amountNgn,
          amountUsdc: result.amountUsdc,
          accountName: account.accountName,
          bankName: account.bankName,
          accountNumber: account.accountNumber,
          ref: result.ref,
          stellarTxHash: result.stellarTxHash,
          username: rampUser?.username,
          status: 'completed',
        });
        caption = [
          kind === 'sell'
            ? `✅ Sale complete — ₦${result.amountNgn.toLocaleString('en-NG')} paid to ${account.accountName}`
            : `✅ Successful — ₦${result.amountNgn.toLocaleString('en-NG')} paid to ${account.accountName}`,
          `${account.bankName} · ${account.accountNumber}`,
          `Ref ${result.ref}`,
        ].join('\n');
      } catch (err: unknown) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err), phone, kind },
          'Portal WhatsApp receipt render failed',
        );
      }
    }

    if (receiptPng) {
      try {
        await this.whatsapp.sendImage(phone, {
          buffer: receiptPng,
          mimeType: 'image/png',
          filename,
          caption: caption.slice(0, 1024),
        });
      } catch (err: unknown) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err), phone, kind },
          'Portal WhatsApp receipt image failed',
        );
      }
    }
  }

  private async notifyPortalUsdcSend(
    phone: string,
    opts: {
      amount: number;
      toLabel: string;
      toAddress: string;
      txHash: string;
      network: PortalNetwork;
      sentSymbol?: string;
      username?: string | null;
    },
  ): Promise<void> {
    const asset = opts.sentSymbol && opts.sentSymbol !== 'USDC' ? opts.sentSymbol : 'USDC';
    const text = [
      `✅ Sent ${opts.amount} ${asset} from the web app`,
      `To ${opts.toLabel}`,
      `Network ${opts.network === 'celo' ? 'Celo' : 'Stellar'}`,
      `Tx ${opts.txHash.slice(0, 12)}…`,
    ].join('\n');

    try {
      await this.notifyPortalWhatsApp(phone, text);
      const receiptPng = await renderTransferReceiptPng({
        brandName: getRampConfig().brandName,
        amount: opts.amount,
        asset,
        toLabel: opts.toLabel,
        toAddress: opts.toAddress,
        txHash: opts.txHash,
        username: opts.username,
        direction: 'sent',
      });
      await this.whatsapp.sendImage(phone, {
        buffer: receiptPng,
        mimeType: 'image/png',
        filename: 'banjee-receipt.png',
        caption: text.slice(0, 1024),
      });
    } catch (err: unknown) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), phone },
        'Portal USDC send WhatsApp notify failed',
      );
    }
  }

  private async notifyPortalBillOutcome(
    phone: string,
    result: {
      receiptPng?: Buffer | null;
      message?: string;
      ref?: string;
      amountNgn?: number;
      amountUsdc?: number;
      status?: string;
    },
    opts: {
      filename: string;
      headline: string;
      rows: Array<{ label: string; value: string }>;
    },
  ): Promise<void> {
    const message = (result.message || '').trim();
    const text =
      message ||
      [
        `✅ ${opts.headline} from the web app`,
        ...opts.rows.map((r) => `${r.label}: ${r.value}`),
        result.amountNgn != null ? `₦${Number(result.amountNgn).toLocaleString('en-NG')}` : '',
        result.ref ? `Ref ${result.ref}` : '',
      ]
        .filter(Boolean)
        .join('\n');

    try {
      if (text) await this.notifyPortalWhatsApp(phone, text);

      let receiptPng = result.receiptPng ?? null;
      if (!receiptPng && result.ref && result.amountNgn != null) {
        const rampUser = await this.store.getUser(phone).catch(() => null);
        const status =
          String(result.status || '').toLowerCase() === 'completed' ||
          String(result.status || '').toLowerCase() === 'success'
            ? 'completed'
            : 'submitted';
        receiptPng = await renderBillReceiptPng({
          brandName: getRampConfig().brandName,
          headline: opts.headline,
          amountNgn: Number(result.amountNgn),
          amountUsdc: result.amountUsdc,
          rows: opts.rows,
          ref: result.ref,
          username: rampUser?.username,
          status,
        });
      }

      if (receiptPng) {
        await this.whatsapp.sendImage(phone, {
          buffer: receiptPng,
          mimeType: 'image/png',
          filename: opts.filename,
          caption: text.slice(0, 1024) || undefined,
        });
      }
    } catch (err: unknown) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), phone },
        'Portal WhatsApp bill receipt failed',
      );
    }
  }

  private async notifyPortalWhatsApp(phone: string, body: string): Promise<void> {
    if (!body?.trim()) return;
    try {
      await this.whatsapp.sendText(phone, body);
    } catch (err: unknown) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err), phone },
        'Portal WhatsApp notify failed',
      );
    }
  }

  /** The WhatsApp identity (ZyRampUser.phone) behind a portal user. */
  private async rampPhone(userId: string): Promise<string> {
    const user = await this.db.user.findFirst({
      where: { id: userId },
      select: { phoneE164: true },
    });
    if (user?.phoneE164) {
      const wa = Phone.toWhatsAppId(user.phoneE164);
      const local =
        user.phoneE164.startsWith('+234') && user.phoneE164.length >= 14
          ? `0${user.phoneE164.slice(4)}`
          : undefined;
      const candidates = [
        ...new Set([wa, user.phoneE164, `+${wa}`, local].filter(Boolean)),
      ] as string[];
      const ramp = await this.db.zyRampUser.findFirst({
        where: { phone: { in: candidates } },
        select: { phone: true },
      });
      if (ramp) return ramp.phone;
    }
    throw new AppException(ErrorCode.PRECONDITION_FAILED, {
      message:
        'No BANJEE wallet is linked to this phone number yet. Say hi to BANJEE on WhatsApp to set one up.',
    });
  }

  private async spendWallet(phone: string, network: PortalNetwork): Promise<string> {
    // Bank sends and bills always need the Stellar wallet; Celo spends need both.
    const stellarWallet = await this.commands.ensureZyloWallet(phone);
    const celoWallet = network === 'celo' ? await this.commands.ensureCeloWallet(phone) : 'n/a';
    if (!stellarWallet || !celoWallet) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: 'Your wallet on this network is not ready yet.',
      });
    }
    return stellarWallet;
  }

  private async resolveAccount(accountNumber: string, bankCode: string) {
    try {
      return await this.naira.resolveAccount(accountNumber, bankCode);
    } catch (e) {
      if (e instanceof AppException) throw e;
      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
        message: "We couldn't verify that account. Check the number and bank.",
      });
    }
  }

  private async payoutAccountFor(phone: string, id?: number) {
    const accounts = await this.store.listPayoutAccounts(phone);
    const account = id
      ? accounts.find((a) => a.id === id)
      : (accounts.find((a) => a.isDefault) ?? accounts[0]);
    if (!account?.bankCode) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: 'Add a bank account to receive your Naira before selling.',
      });
    }
    return account;
  }

  private async savePayoutAccount(
    phone: string,
    account: { bankCode: string; bankName: string; accountNumber: string; accountName: string },
  ) {
    try {
      const existing = await this.store.listPayoutAccounts(phone);
      await this.store.upsertPayoutAccount({
        phone,
        ...account,
        makeDefault: existing.length === 0,
      });
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'Saving payout account skipped',
      );
    }
  }

  private billResult(
    result: Awaited<ReturnType<RampBillsService['executeAirtime']>>,
    extra: { phone: string; mobileNetwork: PortalMobileNetwork },
  ) {
    const status: PortalTxStatus =
      result.status === BillOrderStatus.Completed
        ? 'completed'
        : result.status === BillOrderStatus.Failed
          ? 'failed'
          : 'processing';
    return {
      ref: result.ref,
      status,
      amountNgn: result.amountNgn,
      amountUsdc: result.amountUsdc,
      network: result.chain,
      phone: extra.phone,
      mobileNetwork: extra.mobileNetwork,
    };
  }

  private bankSendStatus(status: string): PortalTxStatus {
    if (status === 'completed') return 'completed';
    if (status === 'failed' || status === 'refunded' || status === 'cancelled') return 'failed';
    return 'processing';
  }

  private assertBankSendLimits(amountNgn: number) {
    const config = getRampConfig();
    if (
      !Number.isInteger(amountNgn) ||
      amountNgn < config.minBankSendNgn ||
      amountNgn > config.maxBankSendNgn
    ) {
      throw new AppException(ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED, {
        message: `Transfers must be between ₦${config.minBankSendNgn.toLocaleString('en-NG')} and ₦${config.maxBankSendNgn.toLocaleString('en-NG')}.`,
        details: { minimum: String(config.minBankSendNgn), maximum: String(config.maxBankSendNgn) },
      });
    }
  }

  private parseUsdc(raw: string): number {
    const amount = Math.round(Number(raw) * 1e6) / 1e6;
    if (!Number.isFinite(amount) || amount <= 0)
      throw this.invalid('Enter an amount greater than zero.');
    return amount;
  }

  private invalid(message: string) {
    return new AppException(ErrorCode.VALIDATION_FAILED, { message });
  }

  private samePhone(a: string, b: string) {
    return a.replace(/\D/g, '') === b.replace(/\D/g, '');
  }

  private sameAddress(a: string, b: string) {
    return a.toLowerCase() === b.toLowerCase();
  }

  /**
   * Maps the ramp services' plain errors onto API error codes. Operator
   * configuration details (env names, vaults) never reach the client.
   */
  private toPortalError(e: unknown, action: string): Error {
    if (e instanceof AppException || e instanceof OutcomeUnknownError) return e;
    const message = e instanceof Error ? e.message : String(e);
    this.logger.warn({ err: message, action }, 'Portal action failed');

    if (/not confirmed|refund also failed|crypto was collected/i.test(message)) {
      return new OutcomeUnknownError(message);
    }
    if (/was refunded/i.test(message)) {
      return new AppException(ErrorCode.BILL_ORDER_REJECTED, {
        message: 'The provider could not complete this. Your USDC was refunded.',
      });
    }
    if (/insufficient/i.test(message)) {
      return new AppException(ErrorCode.INSUFFICIENT_BALANCE, {
        message: "You don't have enough balance on this network.",
      });
    }
    if (/must be between|too small|invalid data plan|max /i.test(message)) {
      return new AppException(ErrorCode.VALIDATION_FAILED, { message });
    }
    if (/not ready|not set|not configured|wa_ramp|vault|rate is not configured/i.test(message)) {
      return new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: "This isn't available right now. Try again later.",
      });
    }
    return new AppException(ErrorCode.UPSTREAM_ERROR, {
      message: "We couldn't complete this right now. Try again shortly.",
    });
  }
}
