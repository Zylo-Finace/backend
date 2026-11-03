import type { Money } from '../../core/money/money';

/**
 * The five things this platform sells. Deliberately closed: each one has its own
 * upstream endpoint, its own catalogue shape and its own verification rules, so
 * "just add a vertical" is never a one-line change and should not look like one.
 */
export enum BillVertical {
  Airtime = 'airtime',
  Data = 'data',
  Electricity = 'electricity',
  CableTv = 'cable_tv',
  Betting = 'betting',
}

/** Mobile networks, keyed by the code ClubKonnect expects on the wire. */
export enum MobileNetwork {
  Mtn = '01',
  Glo = '02',
  NineMobile = '03',
  Airtel = '04',
}

/** Cable providers. The value is the `CableTV` parameter. */
export enum CableProvider {
  Dstv = 'dstv',
  Gotv = 'gotv',
  Startimes = 'startimes',
  Showmax = 'showmax',
}

/** Prepaid buys units; postpaid settles an existing bill. */
export enum MeterType {
  Prepaid = '01',
  Postpaid = '02',
}

/**
 * Where an order has got to.
 *
 * `Unknown` is not a synonym for failure. It means the provider gave an answer
 * we refuse to interpret as either outcome, and a human or a reconciliation job
 * must resolve it. Collapsing it into `Failed` is how a customer gets refunded
 * for airtime they actually received.
 */
export enum BillOrderStatus {
  /** Accepted, not yet worked. */
  Pending = 'pending',
  /** Sent downstream, awaiting the network's answer. */
  Processing = 'processing',
  /** Delivered. Terminal. */
  Completed = 'completed',
  /** Refused before delivery. Terminal — safe to refund. */
  Failed = 'failed',
  /** Reversed after acceptance. Terminal — safe to refund. */
  Cancelled = 'cancelled',
  /** Stuck upstream; the provider retries on its own schedule. Not terminal. */
  OnHold = 'on_hold',
  /** Indeterminate. Never refund on this without checking. */
  Unknown = 'unknown',
}

/** Statuses after which the outcome can no longer change. */
export const TERMINAL_BILL_STATUSES: ReadonlySet<BillOrderStatus> = new Set([
  BillOrderStatus.Completed,
  BillOrderStatus.Failed,
  BillOrderStatus.Cancelled,
]);

export function isTerminalBillStatus(status: BillOrderStatus): boolean {
  return TERMINAL_BILL_STATUSES.has(status);
}

/** Whether a status means the customer can be refunded without further checks. */
export function isRefundableBillStatus(status: BillOrderStatus): boolean {
  return status === BillOrderStatus.Failed || status === BillOrderStatus.Cancelled;
}

// =============================================================================
//  Catalogue
// =============================================================================

/** Bounds a product accepts, as the provider states them. */
export interface AmountBounds {
  min: Money;
  max: Money;
}

/** One purchasable data bundle. */
export interface DataPlan {
  network: MobileNetwork;
  networkName: string;
  /** The `DataPlan` parameter value — the catalogue's `PRODUCT_ID`. */
  code: string;
  name: string;
  /** What ClubKonnect charges our float. Not what we charge the customer. */
  price: Money;
}

/** One cable bouquet. */
export interface CablePackage {
  provider: CableProvider;
  /** The `Package` parameter value — the catalogue's `PACKAGE_ID`. */
  code: string;
  name: string;
  /** List price of the bouquet. */
  price: Money;
  /** What our float is actually charged, after the reseller discount. */
  costPrice: Money;
  bounds: AmountBounds;
}

/** One electricity distribution company and the meter types it supports. */
export interface ElectricityDisco {
  /** The `ElectricCompany` parameter value. */
  code: string;
  name: string;
  meterTypes: MeterType[];
  bounds: AmountBounds;
}

/** One betting platform that can be funded. */
export interface BettingCompany {
  /** The `BettingCompany` parameter value, e.g. `product-bet-king`. */
  code: string;
  name: string;
  bounds: AmountBounds;
}

/** Everything sellable, as one snapshot. */
export interface BillCatalogue {
  dataPlans: DataPlan[];
  cablePackages: CablePackage[];
  discos: ElectricityDisco[];
  bettingCompanies: BettingCompany[];
}

// =============================================================================
//  Verification
// =============================================================================

/**
 * The account an identifier resolves to upstream.
 *
 * Returned before every electricity, cable and betting order. Its purpose is to
 * put a human-readable name in front of the customer *before* money moves: a
 * mistyped meter number that happens to be valid credits a stranger, and none of
 * these three are reversible.
 */
export interface VerifiedCustomer {
  /** The identifier that was checked (meter, smartcard or betting customer id). */
  identifier: string;
  /** The name the provider holds. Authoritative — never the customer's typing. */
  name: string;
}

// =============================================================================
//  Orders
// =============================================================================

interface BaseOrderRequest {
  /**
   * Our idempotency key, sent as `RequestID`.
   *
   * ClubKonnect will not accept the same one twice, which is what makes a retry
   * after a timeout safe: the second attempt is rejected as a duplicate rather
   * than delivering a second bundle.
   */
  reference: string;
}

export interface AirtimeOrderRequest extends BaseOrderRequest {
  network: MobileNetwork;
  amount: Money;
  /** Nigerian MSISDN in local `0803…` form, which is what the provider expects. */
  phoneNumber: string;
}

export interface DataOrderRequest extends BaseOrderRequest {
  network: MobileNetwork;
  /** A {@link DataPlan.code}. */
  planCode: string;
  phoneNumber: string;
}

export interface ElectricityOrderRequest extends BaseOrderRequest {
  /** An {@link ElectricityDisco.code}. */
  discoCode: string;
  meterType: MeterType;
  meterNumber: string;
  amount: Money;
  /** Where the token is sent by SMS, and the number on the receipt. */
  phoneNumber: string;
}

export interface CableTvOrderRequest extends BaseOrderRequest {
  provider: CableProvider;
  /** A {@link CablePackage.code}. */
  packageCode: string;
  smartCardNumber: string;
  phoneNumber: string;
}

export interface BettingOrderRequest extends BaseOrderRequest {
  /** A {@link BettingCompany.code}. */
  companyCode: string;
  customerId: string;
  amount: Money;
  /**
   * Customer mobile when the biller requires it (FalconPay Sportybet, etc.).
   * Omit when the account ID itself is the MSISDN.
   */
  phoneNumber?: string;
}

/**
 * What the provider said when handed an order.
 *
 * As with payouts, there is no "succeeded" here at acceptance time — only a
 * status. ClubKonnect frequently answers `100 ORDER_RECEIVED` and completes
 * minutes later on a callback.
 */
export interface BillOrder {
  /** Our `reference`, echoed back. The join key to any local record. */
  reference: string;
  /** ClubKonnect's `orderid`. What support escalations are keyed on. */
  providerOrderId?: string;
  vertical: BillVertical;
  status: BillOrderStatus;
  /** The provider's numeric code, e.g. `100`. Kept for auditing. */
  statusCode: string;
  /** The provider's own wording, safe to show a customer. */
  remark?: string;
  /** Prepaid electricity token, when one has been issued. */
  meterToken?: string;
  /** Amount debited from our float, when the provider reports it. */
  amountCharged?: Money;
  /** Verbatim response, retained for disputes. */
  raw: Record<string, unknown>;
}

/** An order status update delivered to our callback URL. */
export interface BillOrderCallback {
  reference?: string;
  providerOrderId?: string;
  status: BillOrderStatus;
  statusCode: string;
  remark?: string;
  raw: Record<string, unknown>;
}

// =============================================================================
//  Provider
// =============================================================================

/**
 * A provider that delivers value against a prepaid float we hold with them.
 *
 * ## Why this is a third interface
 *
 * `PaymentProvider` brings money in, `PayoutProvider` sends money out, and this
 * spends money on the customer's behalf. The economics differ in a way that
 * matters: there is no per-transaction settlement here, only a float that
 * depletes, so every call is gated on a balance the other two never consult.
 *
 * Like its siblings, it speaks in our vocabulary ({@link Money},
 * {@link BillOrderStatus}) so that ClubKonnect's naira-strings, `01`-style
 * network codes and 600-series hold semantics never escape the adapter.
 */
export interface BillsProvider {
  readonly name: string;

  /**
   * Our remaining float with the provider.
   *
   * Read before every order. Callers should treat the result as advisory: it can
   * only ever be a moment old, and the provider remains the authority — it will
   * reject an order it cannot fund regardless of what this returned.
   */
  getFloatBalance(): Promise<Money>;

  /** The full sellable catalogue. Expensive and slow; callers are expected to cache. */
  fetchCatalogue(): Promise<BillCatalogue>;

  verifyMeter(
    discoCode: string,
    meterNumber: string,
    meterType: MeterType,
  ): Promise<VerifiedCustomer>;

  verifySmartCard(provider: CableProvider, smartCardNumber: string): Promise<VerifiedCustomer>;

  verifyBettingCustomer(companyCode: string, customerId: string): Promise<VerifiedCustomer>;

  buyAirtime(request: AirtimeOrderRequest): Promise<BillOrder>;
  buyData(request: DataOrderRequest): Promise<BillOrder>;
  payElectricity(request: ElectricityOrderRequest): Promise<BillOrder>;
  subscribeCableTv(request: CableTvOrderRequest): Promise<BillOrder>;
  fundBetting(request: BettingOrderRequest): Promise<BillOrder>;

  /**
   * Re-reads an order from the provider.
   *
   * The only safe way to resolve a {@link BillOrderStatus.Unknown} or a timeout.
   */
  queryOrder(params: { reference?: string; providerOrderId?: string }): Promise<BillOrder>;

  /** Translates a callback payload into our vocabulary. */
  parseCallback(payload: unknown): BillOrderCallback;
}

/** DI token for the configured bills provider. */
export const BILLS_PROVIDER = Symbol('BILLS_PROVIDER');

/**
 * A provider that sells **only** airtime and data.
 *
 * A genuine capability split rather than an oversight. Most VTU aggregators do
 * the two high-volume verticals and nothing else; SMEPlug is one of them. Making
 * such a provider implement the full {@link BillsProvider} would mean five
 * methods that exist only to throw, and a router that has to know which of those
 * throws are real failures and which are "not supported here" — the difference
 * between falling back and giving up.
 *
 * Narrowing the type instead makes the unsupported verticals unrepresentable,
 * so the router cannot route them anywhere but the full provider.
 */
export interface AirtimeDataProvider {
  readonly name: string;

  /** Our remaining float with this provider. Advisory, as above. */
  getFloatBalance(): Promise<Money>;

  /** Just the data catalogue — this provider has no other verticals to offer. */
  fetchDataPlans(): Promise<DataPlan[]>;

  buyAirtime(request: AirtimeOrderRequest): Promise<BillOrder>;
  buyData(request: DataOrderRequest): Promise<BillOrder>;

  /** Translates this provider's webhook payload into our vocabulary. */
  parseCallback(payload: unknown): BillOrderCallback;
}

/** DI token for the airtime/data provider that leads, when one is configured. */
export const AIRTIME_DATA_PROVIDER = Symbol('AIRTIME_DATA_PROVIDER');
