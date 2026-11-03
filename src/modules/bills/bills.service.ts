import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { Phone } from '../../core/utils/phone.util';
import { CacheNamespace } from '../../infrastructure/cache/cache-key';
import { CacheService } from '../../infrastructure/cache/cache.service';
import {
  BILLS_PROVIDER,
  type BillOrder,
  type BillOrderCallback,
  type BillsProvider,
  BillVertical,
  type CableProvider,
  type MeterType,
  type MobileNetwork,
  type VerifiedCustomer,
  isRefundableBillStatus,
} from './bills-provider.interface';
import { BillsCatalogueService } from './bills.catalogue';

/** What a caller must supply to buy airtime. */
export interface BuyAirtimeInput {
  network: MobileNetwork;
  phoneNumber: string;
  amount: Money;
  reference?: string;
}

export interface BuyDataInput {
  network: MobileNetwork;
  phoneNumber: string;
  planCode: string;
  reference?: string;
}

export interface PayElectricityInput {
  discoCode: string;
  meterType: MeterType;
  meterNumber: string;
  amount: Money;
  phoneNumber: string;
  reference?: string;
}

export interface SubscribeCableTvInput {
  provider: CableProvider;
  packageCode: string;
  smartCardNumber: string;
  phoneNumber: string;
  reference?: string;
}

export interface FundBettingInput {
  companyCode: string;
  customerId: string;
  amount: Money;
  /** Required by some billers (e.g. FalconPay Sportybet). Defaults to customerId. */
  phoneNumber?: string;
  reference?: string;
}

/** The outcome of a purchase attempt. */
export interface BillPurchaseResult {
  order: BillOrder;
  /**
   * What the order is expected to cost our float.
   *
   * Known before the order is placed — it is what the float check was made
   * against — and is the figure to price the customer from. The provider's own
   * `amountCharged` supersedes it once the order reaches a terminal state.
   */
  cost: Money;
  /** The name the identifier resolved to, for verticals that support a lookup. */
  customerName?: string;
}

/**
 * Bill payments: airtime, data, electricity, cable TV and betting top-ups.
 *
 * ## The order of operations, and why it is this one
 *
 * Every purchase runs the same sequence, and each step exists to stop a specific
 * way customers lose money:
 *
 * 1. **Normalise and validate the input.** A Nigerian MSISDN has four common
 *    written forms; the provider accepts one.
 * 2. **Resolve the product from the catalogue.** This yields the *cost*, which
 *    for data and cable exists nowhere in the request, and rejects bad codes
 *    locally instead of as an ambiguous upstream error.
 * 3. **Verify the recipient**, for the three verticals that support it. Meters,
 *    smartcards and betting accounts are not reversible: a valid-but-wrong
 *    identifier credits a stranger permanently.
 * 4. **Check the float covers it.** See {@link assertFloatCovers}.
 * 5. **Place the order.**
 *
 * ## What this service deliberately does not do
 *
 * It does not debit a customer wallet, write a ledger entry or persist an order.
 * Those belong to the caller that owns the customer relationship, and folding
 * them in here would mean the float check and the ledger transaction shared a
 * lifetime they should not. The seam is {@link BillPurchaseResult}: it carries
 * everything a ledger write needs, and {@link BillOrder.status} says plainly
 * whether the outcome is settled, still moving, or unknown.
 */
@Injectable()
export class BillsService {
  constructor(
    @Inject(BILLS_PROVIDER) private readonly provider: BillsProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly catalogue: BillsCatalogueService,
    private readonly cache: CacheService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BillsService.name);
  }

  // ===========================================================================
  //  Float
  // ===========================================================================

  private get balanceCacheKey(): string {
    return this.cache.keys.global(CacheNamespace.Bill, 'float', this.provider.name);
  }

  /**
   * Our remaining balance with the upstream provider.
   *
   * Cached for a few seconds by default. The TTL is short because this figure
   * gates spending, and a stale-high reading lets orders through that the
   * provider will refuse.
   */
  async getFloatBalance(): Promise<Money> {
    const ttl = this.config.bills.balanceCacheSeconds;
    if (ttl <= 0) return this.provider.getFloatBalance();

    const cached = await this.cache.get<string>(this.balanceCacheKey);
    if (cached !== undefined) return Money.fromNaira(cached);

    const balance = await this.provider.getFloatBalance();
    await this.cache.set(this.balanceCacheKey, balance.toDecimalString(), { ttlSeconds: ttl });
    return balance;
  }

  /**
   * Refuses the order unless the float covers it, plus the configured reserve.
   *
   * ## What this check is, and what it is not
   *
   * It is a **pre-flight guard**, not a guarantee. Between reading the balance
   * and the provider debiting it, other orders are in flight — so the reserve
   * exists to absorb that gap, and the provider stays the authority: it will
   * reject an order it cannot fund no matter what this returned.
   *
   * What it buys is the difference between a clean, immediate refusal and the
   * mess that follows an upstream `INSUFFICIENT_BALANCE`: an order the customer
   * has already been charged for, sitting in a non-terminal state, needing a
   * reconciliation pass to unwind. Catching it here means the customer's wallet
   * was never touched.
   *
   * Failing *open* when the balance cannot be read would defeat the point, so a
   * provider that will not report its balance stops orders too.
   */
  async assertFloatCovers(cost: Money, context: Record<string, unknown>): Promise<Money> {
    const balance = await this.getFloatBalance();
    const reserve = Money.fromNaira(this.config.bills.floatReserveNaira);
    const available = balance.subtract(reserve);

    if (available.lessThan(cost)) {
      // Deliberately loud: this is an operational alarm, not a customer error.
      // Nothing sells until somebody tops the float up.
      this.logger.error(
        {
          ...context,
          balance: balance.toDecimalString(),
          reserve: reserve.toDecimalString(),
          required: cost.toDecimalString(),
        },
        'Upstream float cannot cover this order; refusing before it is placed',
      );

      throw new AppException(ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED, {
        message: 'This service is temporarily unavailable. Please try again shortly.',
        // The shortfall stays out of `details` — it is our commercial position,
        // not something a customer should be able to probe.
        details: { vertical: context.vertical },
      });
    }

    return balance;
  }

  /**
   * Drops the cached balance after an order, since the float has just moved.
   *
   * Best-effort: a failure here costs accuracy for a few seconds, never
   * correctness, so it must not fail a purchase that has already gone through.
   */
  private async invalidateFloatBalance(): Promise<void> {
    await this.cache.delete(this.balanceCacheKey);
  }

  // ===========================================================================
  //  Verification
  // ===========================================================================

  /**
   * Resolves a meter number to its account holder.
   *
   * Exposed separately so a UI can show the name for confirmation before the
   * customer commits. The purchase path re-runs it regardless — a name confirmed
   * in a previous request proves nothing about the identifier in this one.
   */
  async verifyMeter(
    discoCode: string,
    meterNumber: string,
    meterType: MeterType,
  ): Promise<VerifiedCustomer> {
    await this.catalogue.requireDisco(discoCode, meterType);
    return this.provider.verifyMeter(
      discoCode,
      requireIdentifier(meterNumber, 'meter number'),
      meterType,
    );
  }

  async verifySmartCard(
    provider: CableProvider,
    smartCardNumber: string,
  ): Promise<VerifiedCustomer> {
    return this.provider.verifySmartCard(
      provider,
      requireIdentifier(smartCardNumber, 'smartcard number'),
    );
  }

  async verifyBettingCustomer(companyCode: string, customerId: string): Promise<VerifiedCustomer> {
    await this.catalogue.requireBettingCompany(companyCode);
    return this.provider.verifyBettingCustomer(
      companyCode,
      requireIdentifier(customerId, 'customer ID'),
    );
  }

  // ===========================================================================
  //  Purchases
  // ===========================================================================

  async buyAirtime(input: BuyAirtimeInput): Promise<BillPurchaseResult> {
    const phoneNumber = toLocalMsisdn(input.phoneNumber);
    const reference = this.resolveReference(input.reference);

    // Airtime has no catalogue entry: face value is what the customer asks for,
    // and our float is charged that less the reseller discount. Checking against
    // the undiscounted figure is the conservative direction to be wrong in.
    const cost = input.amount;
    assertWholeNaira(cost);

    await this.assertFloatCovers(cost, { vertical: BillVertical.Airtime, reference });

    const order = await this.provider.buyAirtime({
      network: input.network,
      amount: input.amount,
      phoneNumber,
      reference,
    });

    await this.invalidateFloatBalance();

    if (isRefundableBillStatus(order.status)) {
      throw new AppException(ErrorCode.BILL_ORDER_REJECTED, {
        message: order.remark || 'The airtime provider declined this order',
        details: { vertical: BillVertical.Airtime, reference, status: order.status },
        retryable: false,
      });
    }

    return { order, cost };
  }

  async buyData(input: BuyDataInput): Promise<BillPurchaseResult> {
    const phoneNumber = toLocalMsisdn(input.phoneNumber);
    const reference = this.resolveReference(input.reference);

    const plan = await this.catalogue.requireDataPlan(input.network, input.planCode);

    await this.assertFloatCovers(plan.price, { vertical: BillVertical.Data, reference });

    const order = await this.provider.buyData({
      network: input.network,
      planCode: plan.code,
      phoneNumber,
      reference,
    });

    await this.invalidateFloatBalance();

    if (isRefundableBillStatus(order.status)) {
      throw new AppException(ErrorCode.BILL_ORDER_REJECTED, {
        message: order.remark || 'The data provider declined this order',
        details: { vertical: BillVertical.Data, reference, status: order.status },
        retryable: false,
      });
    }

    return { order, cost: plan.price };
  }

  async payElectricity(input: PayElectricityInput): Promise<BillPurchaseResult> {
    const phoneNumber = toLocalMsisdn(input.phoneNumber);
    const meterNumber = requireIdentifier(input.meterNumber, 'meter number');
    const reference = this.resolveReference(input.reference);

    const disco = await this.catalogue.requireDisco(input.discoCode, input.meterType);
    this.catalogue.assertWithinBounds(input.amount, disco.bounds, {
      vertical: BillVertical.Electricity,
      discoCode: disco.code,
    });
    assertWholeNaira(input.amount);

    // Before the float check: a wrong meter number is the customer's error and
    // should be reported as such, regardless of our float position.
    const customer = await this.provider.verifyMeter(disco.code, meterNumber, input.meterType);

    await this.assertFloatCovers(input.amount, { vertical: BillVertical.Electricity, reference });

    const order = await this.provider.payElectricity({
      discoCode: disco.code,
      meterType: input.meterType,
      meterNumber,
      amount: input.amount,
      phoneNumber,
      reference,
    });

    await this.invalidateFloatBalance();
    return { order, cost: input.amount, customerName: customer.name };
  }

  async subscribeCableTv(input: SubscribeCableTvInput): Promise<BillPurchaseResult> {
    const phoneNumber = toLocalMsisdn(input.phoneNumber);
    const smartCardNumber = requireIdentifier(input.smartCardNumber, 'smartcard number');
    const reference = this.resolveReference(input.reference);

    const bouquet = await this.catalogue.requireCablePackage(input.provider, input.packageCode);
    const customer = await this.provider.verifySmartCard(input.provider, smartCardNumber);

    await this.assertFloatCovers(bouquet.costPrice, {
      vertical: BillVertical.CableTv,
      reference,
    });

    const order = await this.provider.subscribeCableTv({
      provider: input.provider,
      packageCode: bouquet.code,
      smartCardNumber,
      phoneNumber,
      reference,
    });

    await this.invalidateFloatBalance();
    return { order, cost: bouquet.costPrice, customerName: customer.name };
  }

  async fundBetting(input: FundBettingInput): Promise<BillPurchaseResult> {
    const customerId = requireIdentifier(input.customerId, 'customer ID');
    const reference = this.resolveReference(input.reference);

    const company = await this.catalogue.requireBettingCompany(input.companyCode);
    this.catalogue.assertWithinBounds(input.amount, company.bounds, {
      vertical: BillVertical.Betting,
      companyCode: company.code,
    });
    assertWholeNaira(input.amount);

    const customer = await this.provider.verifyBettingCustomer(company.code, customerId);

    await this.assertFloatCovers(input.amount, { vertical: BillVertical.Betting, reference });

    // Prefer an explicit phone, then a phone-shaped verify result (FalconPay
    // returns the normalised MSISDN as the "name"), then the account id itself.
    const phoneNumber =
      input.phoneNumber ||
      (/^\d{10,14}$/.test(customer.name) ? customer.name : undefined) ||
      customerId;

    const order = await this.provider.fundBetting({
      companyCode: company.code,
      customerId,
      phoneNumber,
      amount: input.amount,
      reference,
    });

    await this.invalidateFloatBalance();
    return { order, cost: input.amount, customerName: customer.name };
  }

  // ===========================================================================
  //  Reconciliation
  // ===========================================================================

  /**
   * Re-reads an order from the provider.
   *
   * The only correct response to a timeout or an
   * {@link BillOrderStatus.Unknown}: those mean the outcome is undetermined, and
   * the provider is the only party that knows it.
   */
  async queryOrder(params: { reference?: string; providerOrderId?: string }): Promise<BillOrder> {
    return this.provider.queryOrder(params);
  }

  /**
   * Interprets a provider callback.
   *
   * The payload is unauthenticated — ClubKonnect signs nothing — so the returned
   * status is a **hint that something changed**, not evidence of what. Callers
   * must confirm with {@link queryOrder} before crediting, refunding or
   * notifying. Acting on this payload directly would let anyone who guesses an
   * order id mark it completed.
   */
  parseCallback(payload: unknown): BillOrderCallback {
    return this.provider.parseCallback(payload);
  }

  // ===========================================================================
  //  Internals
  // ===========================================================================

  /**
   * Validates a caller's reference, or mints one.
   *
   * The date prefix is not decoration: ClubKonnect's own convention for
   * `RequestID` is a timestamp-led unique string, and it keeps references
   * naturally ordered and easy to find in their dashboard during a dispute.
   */
  private resolveReference(supplied?: string): string {
    if (supplied === undefined) {
      const stamp = new Date()
        .toISOString()
        .replace(/[-:T.Z]/g, '')
        .slice(0, 14);
      return `${stamp}${randomBytes(5).toString('hex')}`;
    }

    const reference = supplied.trim();
    // The provider echoes this back on callbacks and accepts it in query URLs, so
    // anything outside a conservative alphabet risks a mangled round trip.
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(reference)) {
      throw AppException.validation(
        'Reference must be 6-64 characters of letters, digits, hyphen or underscore',
        { field: 'reference' },
      );
    }
    return reference;
  }
}

// =============================================================================
//  Input normalisation
// =============================================================================

/**
 * Converts any written form of a Nigerian mobile number to the local `0803…`
 * form ClubKonnect expects.
 *
 * The platform stores E.164 everywhere, and this provider accepts only the local
 * form — so the conversion happens once, here, rather than at each call site
 * with a hand-rolled `slice`.
 */
function toLocalMsisdn(input: string): string {
  const e164 = Phone.normalizeOrThrow(input);

  if (!e164.startsWith('+234')) {
    throw new AppException(ErrorCode.VALIDATION_FAILED, {
      message: 'Only Nigerian mobile numbers are supported',
      details: { field: 'phoneNumber' },
    });
  }

  return `0${e164.slice(4)}`;
}

/** Meter, smartcard and betting identifiers: digits and letters, nothing exotic. */
function requireIdentifier(value: string, label: string): string {
  const trimmed = value?.trim() ?? '';

  if (!/^[A-Za-z0-9-]{4,32}$/.test(trimmed)) {
    throw new AppException(ErrorCode.VALIDATION_FAILED, {
      message: `Enter a valid ${label}`,
      details: { field: label },
    });
  }
  return trimmed;
}

/**
 * ClubKonnect prices everything in whole naira.
 *
 * Rejecting a fractional amount here produces a clear error, where letting it
 * through would have the provider truncate it in a way we cannot predict and
 * would leave our expected cost disagreeing with the actual charge.
 */
function assertWholeNaira(amount: Money): void {
  if (amount.kobo % 100n !== 0n) {
    throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
      message: 'Amount must be a whole number of naira',
      details: { amount: amount.toDecimalString() },
    });
  }
}
