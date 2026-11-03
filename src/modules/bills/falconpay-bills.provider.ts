import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  type AirtimeOrderRequest,
  type BettingCompany,
  type BettingOrderRequest,
  type BillCatalogue,
  type BillOrder,
  type BillOrderCallback,
  BillOrderStatus,
  type BillsProvider,
  BillVertical,
  type CablePackage,
  CableProvider,
  type CableTvOrderRequest,
  type DataOrderRequest,
  type DataPlan,
  type ElectricityDisco,
  type ElectricityOrderRequest,
  MeterType,
  MobileNetwork,
  type VerifiedCustomer,
} from './bills-provider.interface';

/** FalconPay's product names, as `product=` expects them. */
type FpProduct = 'airtime' | 'data' | 'tv' | 'electricity' | 'betting';

const PRODUCT_BY_VERTICAL: Readonly<Record<BillVertical, FpProduct>> = Object.freeze({
  [BillVertical.Airtime]: 'airtime',
  [BillVertical.Data]: 'data',
  [BillVertical.CableTv]: 'tv',
  [BillVertical.Electricity]: 'electricity',
  [BillVertical.Betting]: 'betting',
});

const VERTICAL_BY_PRODUCT: ReadonlyMap<string, BillVertical> = new Map(
  Object.entries(PRODUCT_BY_VERTICAL).map(([vertical, product]) => [
    product,
    vertical as BillVertical,
  ]),
);

const NETWORK_NAME: Readonly<Record<MobileNetwork, string>> = Object.freeze({
  [MobileNetwork.Mtn]: 'MTN',
  [MobileNetwork.Glo]: 'Glo',
  [MobileNetwork.Airtel]: 'Airtel',
  [MobileNetwork.NineMobile]: '9Mobile',
});

/**
 * What a network's service id is assumed to be when their service list cannot
 * be read. Only used as a last resort — the list is the authority.
 */
const DEFAULT_SERVICE_ID: Readonly<Record<MobileNetwork, { airtime: string; data: string }>> =
  Object.freeze({
    [MobileNetwork.Mtn]: { airtime: 'mtn', data: 'mtn-data' },
    [MobileNetwork.Glo]: { airtime: 'glo', data: 'glo-data' },
    [MobileNetwork.Airtel]: { airtime: 'airtel', data: 'airtel-data' },
    [MobileNetwork.NineMobile]: { airtime: 'etisalat', data: 'etisalat-data' },
  });

/**
 * Marks a bundle code as FalconPay's.
 *
 * Same reasoning as SMEPlug's `sp:` prefix: a bare variation code is ambiguous
 * the moment catalogues are merged. The service id rides along because the pay
 * call needs it, and the order request carries only the code.
 */
export const FALCONPAY_PLAN_PREFIX = 'fp';

export function encodeFalconPayCode(serviceId: string, variationCode: string): string {
  return `${FALCONPAY_PLAN_PREFIX}:${serviceId}:${variationCode}`;
}

export function decodeFalconPayCode(
  code: string,
): { serviceId: string; variationCode: string } | null {
  const first = code.indexOf(':');
  const second = code.indexOf(':', first + 1);
  if (first < 0 || second < 0 || code.slice(0, first) !== FALCONPAY_PLAN_PREFIX) return null;
  const serviceId = code.slice(first + 1, second);
  const variationCode = code.slice(second + 1);
  if (!serviceId || !variationCode) return null;
  return { serviceId, variationCode };
}

export function isFalconPayPlanCode(code: string): boolean {
  return decodeFalconPayCode(code) !== null;
}

interface FpEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
  error?: string;
}

interface FpService {
  service_id?: string;
  name?: string;
  min?: string | number;
  max?: string | number;
}

interface FpVariation {
  variation_code?: string;
  name?: string;
  amount?: string | number;
}

interface FpQuote {
  face_amount?: number | string;
  your_discount?: number | string;
  amount_to_be_debited?: number | string;
  quote_token?: string;
  quote_exp?: number | string;
}

/** `/bills/pay` and `/bills/status` `data`, and the webhook body. */
interface FpBillRecord {
  reference?: string;
  transaction_reference?: string;
  status?: string;
  settled?: boolean;
  success?: boolean;
  product?: string;
  service_id?: string;
  face_amount?: number | string;
  amount_debited?: number | string;
  discount?: number | string;
  token?: string;
  units?: string;
  message?: string;
  event?: string;
  type?: string;
}

interface FpResponse<T> {
  status: number;
  headers: Headers;
  body: FpEnvelope<T> | null;
}

/** What a transport failure looked like, for the one caller that must not throw. */
class FalconPayTransportError extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? 'FalconPay request timed out' : 'FalconPay could not be reached');
  }
}

/**
 * FalconPay adapter for bill payments — all five verticals off the same wallet
 * that funds transfers.
 *
 * ## The purchase sequence
 *
 * Every order is **quote → pay**. The quote is signed and short-lived and names
 * what our wallet will actually be debited after the discount; `/bills/pay`
 * refuses a request whose amounts do not match it. A fresh quote is taken per
 * order rather than cached, because an expired one is a guaranteed 422.
 *
 * ## The one rule this class exists to enforce
 *
 * **Only a 422 is a failure.** A 202 means the purchase is live and will settle
 * on its own; a timeout or a 5xx on `/bills/pay` means we do not know. Neither is
 * reported as `Failed` — that status is what tells the caller it is safe to
 * refund the customer, and refunding a purchase that then delivers gives the
 * value away twice. So the pay call never throws on an unknown outcome: it asks
 * `/bills/status`, and if that cannot answer either, it returns
 * {@link BillOrderStatus.Unknown}.
 */
@Injectable()
export class FalconPayBillsProvider implements BillsProvider {
  readonly name = 'falconpay';

  /** `product` → its service list, memoised for the catalogue TTL. */
  private readonly services = new Map<FpProduct, { at: number; rows: FpService[] }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FalconPayBillsProvider.name);
  }

  // ===========================================================================
  //  Float
  // ===========================================================================

  /** The FalconPay wallet — shared with transfers, so a busy payout day drains it too. */
  async getFloatBalance(): Promise<Money> {
    const data = await this.read<{ balance?: number | string }>('/api/wallet/balance');
    const balance = data?.balance;

    if (typeof balance !== 'number' && typeof balance !== 'string') {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider did not report a balance',
        retryable: true,
      });
    }
    return Money.fromNaira(normaliseAmount(balance));
  }

  // ===========================================================================
  //  Catalogue
  // ===========================================================================

  /**
   * One snapshot of everything sellable.
   *
   * As with the other adapters, one failed vertical fails the whole snapshot: a
   * partial catalogue would present "no data plans" as though none existed.
   */
  async fetchCatalogue(): Promise<BillCatalogue> {
    const [dataPlans, cablePackages, discos, bettingCompanies] = await Promise.all([
      this.fetchDataPlans(),
      this.fetchCablePackages(),
      this.fetchDiscos(),
      this.fetchBettingCompanies(),
    ]);
    return { dataPlans, cablePackages, discos, bettingCompanies };
  }

  private async fetchDataPlans(): Promise<DataPlan[]> {
    const services = await this.listServices('data', { fresh: true });
    const plans: DataPlan[] = [];

    await Promise.all(
      services.map(async (service) => {
        const serviceId = str(service.service_id);
        const network = networkFromServiceId(serviceId);
        // SME/corporate variants and non-telco ISPs (smile, spectranet) are not
        // sold to a phone number on one of the four networks, so they are left out.
        if (!network || !isPlainNetworkService(serviceId, 'data')) return;

        for (const variation of await this.listVariations('data', serviceId)) {
          const code = str(variation.variation_code);
          if (!code || variation.amount === undefined) continue;
          plans.push({
            network,
            networkName: NETWORK_NAME[network],
            code: encodeFalconPayCode(serviceId, code),
            name: str(variation.name, code).trim(),
            price: Money.fromNaira(normaliseAmount(variation.amount)),
          });
        }
      }),
    );

    return plans;
  }

  private async fetchCablePackages(): Promise<CablePackage[]> {
    const services = await this.listServices('tv', { fresh: true });
    const packages: CablePackage[] = [];

    await Promise.all(
      services.map(async (service) => {
        const serviceId = str(service.service_id);
        const provider = cableProviderFromServiceId(serviceId);
        if (!provider) return;

        for (const variation of await this.listVariations('tv', serviceId)) {
          const code = str(variation.variation_code);
          if (!code || variation.amount === undefined) continue;
          const price = Money.fromNaira(normaliseAmount(variation.amount));
          packages.push({
            provider,
            code: encodeFalconPayCode(serviceId, code),
            name: str(variation.name, code).trim(),
            price,
            // The discount is only known per quote. List price overstates the
            // cost, which makes the float check stricter, never looser.
            costPrice: price,
            bounds: { min: Money.ZERO, max: Money.ZERO },
          });
        }
      }),
    );

    return packages;
  }

  private async fetchDiscos(): Promise<ElectricityDisco[]> {
    const services = await this.listServices('electricity', { fresh: true });
    return services
      .filter((service) => str(service.service_id))
      .map((service) => ({
        code: str(service.service_id),
        name: str(service.name, str(service.service_id)).trim(),
        // `variation_code` is literally `prepaid` or `postpaid` for every disco.
        meterTypes: [MeterType.Prepaid, MeterType.Postpaid],
        bounds: boundsOf(service),
      }));
  }

  private async fetchBettingCompanies(): Promise<BettingCompany[]> {
    const services = await this.listServices('betting', { fresh: true });
    return services
      .filter((service) => str(service.service_id))
      .map((service) => ({
        code: str(service.service_id),
        name: str(service.name, str(service.service_id)).trim(),
        // FalconPay betting rows often omit min/max (unlike electricity).
        bounds: bettingBoundsOf(service),
      }));
  }

  private async listServices(
    product: FpProduct,
    options: { fresh?: boolean } = {},
  ): Promise<FpService[]> {
    const ttlMs = Math.max(this.config.bills.catalogueCacheSeconds, 60) * 1000;
    const cached = this.services.get(product);
    if (!options.fresh && cached && Date.now() - cached.at < ttlMs) return cached.rows;

    const data = await this.read<FpService[]>(
      `/api/bills/services?${new URLSearchParams({ product }).toString()}`,
    );
    const rows = Array.isArray(data) ? data : [];
    this.services.set(product, { at: Date.now(), rows });
    return rows;
  }

  private async listVariations(product: FpProduct, serviceId: string): Promise<FpVariation[]> {
    const data = await this.read<{ variations?: FpVariation[] } | FpVariation[]>(
      `/api/bills/variations?${new URLSearchParams({ product, service_id: serviceId }).toString()}`,
    );
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.variations) ? data.variations : [];
  }

  /** The service id a network sells `product` under, from their list when it can be read. */
  private async serviceIdForNetwork(
    network: MobileNetwork,
    product: 'airtime' | 'data',
  ): Promise<string> {
    try {
      const match = (await this.listServices(product)).find((service) => {
        const id = str(service.service_id);
        return networkFromServiceId(id) === network && isPlainNetworkService(id, product);
      });
      if (match) return str(match.service_id);
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), product },
        'FalconPay service list unavailable; using the default service id',
      );
    }
    return DEFAULT_SERVICE_ID[network][product];
  }

  private async serviceIdForCable(provider: CableProvider): Promise<string> {
    try {
      const match = (await this.listServices('tv')).find(
        (service) => cableProviderFromServiceId(str(service.service_id)) === provider,
      );
      if (match) return str(match.service_id);
    } catch {
      // The enum value is their service id for all four bouquets.
    }
    return provider;
  }

  // ===========================================================================
  //  Verification
  // ===========================================================================

  async verifyMeter(
    discoCode: string,
    meterNumber: string,
    meterType: MeterType,
  ): Promise<VerifiedCustomer> {
    return this.verify(
      {
        product: 'electricity',
        service_id: discoCode,
        customer_id: meterNumber,
        variation_code: meterVariation(meterType),
      },
      'meter number',
    );
  }

  async verifySmartCard(
    provider: CableProvider,
    smartCardNumber: string,
  ): Promise<VerifiedCustomer> {
    return this.verify(
      {
        product: 'tv',
        service_id: await this.serviceIdForCable(provider),
        customer_id: smartCardNumber,
      },
      'smartcard number',
    );
  }

  async verifyBettingCustomer(companyCode: string, customerId: string): Promise<VerifiedCustomer> {
    return this.verify(
      { product: 'betting', service_id: companyCode, customer_id: customerId },
      'customer ID',
    );
  }

  private async verify(
    body: { product: FpProduct; service_id: string; customer_id: string; variation_code?: string },
    label: string,
  ): Promise<VerifiedCustomer> {
    const response = await this.send<Record<string, unknown>>('POST', '/api/bills/verify', body);

    if (response.status === 404 || response.status === 400 || response.status === 422) {
      throw new AppException(ErrorCode.BILL_CUSTOMER_INVALID, {
        message: `That ${label} could not be verified. Please check it and try again.`,
        details: { providerResponse: response.body?.message ?? `HTTP ${response.status}` },
      });
    }

    const data = this.unwrap(response, 'verify');
    const name = str(
      data?.customerName ??
        data?.Customer_Name ??
        data?.customer_name ??
        data?.name ??
        data?.account_name,
    ).trim();
    const identifier = str(
      data?.customer_id ?? data?.customerId ?? data?.Customer_ID ?? body.customer_id,
      body.customer_id,
    );

    // FalconPay betting often returns the normalised MSISDN as `customerName`
    // (e.g. "2348060332714") with no separate human name. Treat that as success.
    if (!name && !identifier) {
      throw new AppException(ErrorCode.BILL_CUSTOMER_INVALID, {
        message: `That ${label} could not be verified. Please check it and try again.`,
        details: { providerResponse: 'empty' },
      });
    }

    return {
      identifier: identifier || body.customer_id,
      name: name || identifier || body.customer_id,
    };
  }

  // ===========================================================================
  //  Orders
  // ===========================================================================

  async buyAirtime(request: AirtimeOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.Airtime, request.reference, {
      serviceId: await this.serviceIdForNetwork(request.network, 'airtime'),
      customerId: request.phoneNumber,
      phone: request.phoneNumber,
      amount: request.amount,
    });
  }

  async buyData(request: DataOrderRequest): Promise<BillOrder> {
    const decoded = decodeFalconPayCode(request.planCode);
    if (!decoded) {
      // A code from another provider's catalogue. Guessing at an equivalent here
      // would deliver a bundle the customer was never quoted.
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That data plan is not available',
        details: { planCode: request.planCode },
      });
    }

    return this.order(BillVertical.Data, request.reference, {
      serviceId: decoded.serviceId,
      variationCode: decoded.variationCode,
      customerId: request.phoneNumber,
      phone: request.phoneNumber,
    });
  }

  async payElectricity(request: ElectricityOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.Electricity, request.reference, {
      serviceId: request.discoCode,
      variationCode: meterVariation(request.meterType),
      customerId: request.meterNumber,
      phone: request.phoneNumber,
      amount: request.amount,
    });
  }

  async subscribeCableTv(request: CableTvOrderRequest): Promise<BillOrder> {
    const decoded = decodeFalconPayCode(request.packageCode);
    if (!decoded) {
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That cable TV package is not available',
        details: { packageCode: request.packageCode },
      });
    }

    return this.order(BillVertical.CableTv, request.reference, {
      serviceId: decoded.serviceId,
      variationCode: decoded.variationCode,
      customerId: request.smartCardNumber,
      phone: request.phoneNumber,
    });
  }

  async fundBetting(request: BettingOrderRequest): Promise<BillOrder> {
    // Sportybet and peers require a customer phone; when the account ID is the
    // MSISDN (common), reuse it. Callers may still pass an explicit phone.
    const phone = request.phoneNumber || request.customerId;
    return this.order(BillVertical.Betting, request.reference, {
      serviceId: request.companyCode,
      customerId: request.customerId,
      phone,
      amount: request.amount,
    });
  }

  /**
   * Quote, then pay.
   *
   * Everything that can go wrong *before* `/bills/pay` is sent is safe to throw
   * — nothing was debited. Everything after is interpreted, never thrown blind.
   */
  private async order(
    vertical: BillVertical,
    reference: string,
    params: {
      serviceId: string;
      customerId: string;
      variationCode?: string;
      phone?: string;
      /** Face value. Omitted for fixed-price bundles, whose price the quote supplies. */
      amount?: Money;
    },
  ): Promise<BillOrder> {
    const product = PRODUCT_BY_VERTICAL[vertical];
    const quote = await this.quote(product, params.serviceId, params.amount, params.variationCode);

    const body = {
      reference,
      product,
      service_id: params.serviceId,
      amount: quote.faceAmount,
      customer_id: params.customerId,
      ...(params.variationCode ? { variation_code: params.variationCode } : {}),
      ...(params.phone ? { phone: params.phone } : {}),
      face_amount: quote.faceAmount,
      net_amount: quote.netAmount,
      quote_exp: quote.exp,
      quote_token: quote.token,
    };

    let response: FpResponse<FpBillRecord>;
    try {
      response = await this.send<FpBillRecord>('POST', '/api/bills/pay', body);
    } catch (error) {
      if (!(error instanceof FalconPayTransportError)) throw error;
      // The request may well have been debited and dispatched; only the answer
      // was lost. Ask, rather than guess.
      this.logger.error(
        { reference, vertical, err: error.message },
        'FalconPay bill payment got no response; checking its status',
      );
      return this.recoverOutcome(vertical, reference, 'no_response');
    }

    const order = this.interpretPay(vertical, reference, response);

    this.logger.info(
      {
        vertical,
        reference,
        httpStatus: response.status,
        providerOrderId: order.providerOrderId,
        status: order.status,
      },
      'FalconPay bill payment placed',
    );

    return order.status === BillOrderStatus.Unknown
      ? this.recoverOutcome(vertical, reference, order.statusCode)
      : order;
  }

  private interpretPay(
    vertical: BillVertical,
    reference: string,
    response: FpResponse<FpBillRecord>,
  ): BillOrder {
    const { status, body } = response;
    const httpCode = String(status);

    if (status === 200 || status === 202) {
      const record = { ...(body?.data ?? {}), reference: body?.data?.reference ?? reference };
      const mapped = toBillOrderStatus(record.status, record.settled);
      // A 202 with no readable status is still, by their contract, in flight.
      const orderStatus =
        status === 202 && mapped === BillOrderStatus.Unknown ? BillOrderStatus.Processing : mapped;
      return this.toBillOrder(vertical, reference, record, orderStatus, body?.message);
    }

    if (status === 409) {
      // Already placed under this reference — by us, on an earlier attempt.
      return this.unknownOrder(vertical, reference, 'duplicate', body?.message);
    }

    if (status === 400 || status === 422) {
      // Declined by the biller, over a limit, or a bad quote. Their contract is
      // that the wallet is refunded in full, so this is safe to refund onward.
      return {
        reference,
        vertical,
        status: BillOrderStatus.Failed,
        statusCode: httpCode,
        remark: body?.message || 'The biller declined this purchase',
        raw: (body ?? {}) as Record<string, unknown>,
      };
    }

    if (status === 401 || status === 403 || status === 503) {
      // Refused before anything was debited: bills disabled, a test key, a PND,
      // or the biller is down.
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Bill payments are temporarily unavailable. Please try again shortly.',
        details: { providerMessage: body?.message ?? `HTTP ${status}` },
        retryable: status === 503,
      });
    }

    if (status === 429) {
      throw new AppException(ErrorCode.RATE_LIMIT_EXCEEDED, {
        message: 'The bill payment provider is rate limiting us; try again shortly',
        details: { retryAfter: response.headers.get('retry-after') ?? undefined },
        retryable: true,
      });
    }

    // 5xx or anything undocumented: their server broke while handling a debit.
    return this.unknownOrder(vertical, reference, httpCode, body?.message);
  }

  /** Resolves an ambiguous pay response through `/bills/status`, degrading to `Unknown`. */
  private async recoverOutcome(
    vertical: BillVertical,
    reference: string,
    reason: string,
  ): Promise<BillOrder> {
    try {
      const order = await this.queryOrder({ reference });
      return { ...order, vertical };
    } catch (error) {
      this.logger.error(
        { reference, reason, err: error instanceof Error ? error.message : String(error) },
        'FalconPay bill outcome could not be confirmed; leaving it unknown for reconciliation',
      );
      return this.unknownOrder(vertical, reference, reason);
    }
  }

  private unknownOrder(
    vertical: BillVertical,
    reference: string,
    statusCode: string,
    remark?: string,
  ): BillOrder {
    return {
      reference,
      vertical,
      status: BillOrderStatus.Unknown,
      statusCode,
      remark: remark || 'Purchase submitted; awaiting confirmation',
      raw: {},
    };
  }

  private async quote(
    product: FpProduct,
    serviceId: string,
    amount: Money | undefined,
    variationCode: string | undefined,
  ): Promise<{ faceAmount: number; netAmount: number; exp: number; token: string }> {
    const query = new URLSearchParams({
      product,
      service_id: serviceId,
      // Ignored upstream for fixed-price bundles, but still a required field.
      amount: amount ? toNairaNumber(amount).toString() : '0',
      ...(variationCode ? { variation_code: variationCode } : {}),
    });

    const response = await this.send<FpQuote>('GET', `/api/bills/quote?${query.toString()}`);

    if (response.status === 400 || response.status === 404 || response.status === 422) {
      throw new AppException(ErrorCode.BILL_ORDER_REJECTED, {
        message: response.body?.message || 'This purchase cannot be priced right now',
        details: { product, serviceId },
        retryable: false,
      });
    }

    const data = this.unwrap(response, 'quote');
    const faceAmount = toNumber(data?.face_amount);
    const netAmount = toNumber(data?.amount_to_be_debited);
    const exp = toNumber(data?.quote_exp);
    const token = str(data?.quote_token);

    if (faceAmount === null || netAmount === null || exp === null || !token) {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider returned an incomplete quote',
        retryable: true,
      });
    }

    // A quote for a different face value than the customer asked for would
    // charge them one figure and deliver another.
    if (amount && Math.abs(faceAmount - toNairaNumber(amount)) > 0.001) {
      throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
        message: 'The quoted amount does not match the requested amount',
        details: { requested: amount.toDecimalString(), quoted: String(faceAmount) },
      });
    }

    return { faceAmount, netAmount, exp, token };
  }

  /**
   * The authoritative state of one of our references.
   *
   * FalconPay re-asks the biller for anything still in flight, so this is the
   * right call after a timeout. `settled: false` is "not yet known", never failure.
   */
  async queryOrder(params: { reference?: string; providerOrderId?: string }): Promise<BillOrder> {
    if (!params.reference) {
      throw AppException.validation('FalconPay bill status is looked up by our reference');
    }

    const response = await this.send<FpBillRecord>(
      'GET',
      `/api/bills/status?${new URLSearchParams({ reference: params.reference }).toString()}`,
    );

    if (response.status === 404) {
      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
        message: 'No bill payment exists under that reference',
        details: { reference: params.reference },
      });
    }

    const record = this.unwrap(response, 'status') ?? {};
    const vertical = VERTICAL_BY_PRODUCT.get(str(record.product)) ?? BillVertical.Airtime;
    return this.toBillOrder(
      vertical,
      params.reference,
      record,
      toBillOrderStatus(record.status, record.settled),
      response.body?.message,
    );
  }

  private toBillOrder(
    vertical: BillVertical,
    reference: string,
    record: FpBillRecord,
    status: BillOrderStatus,
    message?: string,
  ): BillOrder {
    if (status === BillOrderStatus.Unknown) {
      this.logger.warn(
        { reference, providerStatus: record.status },
        'FalconPay returned a bill status we cannot classify',
      );
    }

    const debited = record.amount_debited ?? (record as FpQuote).amount_to_be_debited;

    return {
      reference: str(record.reference, reference),
      providerOrderId: str(record.transaction_reference) || undefined,
      vertical,
      status,
      statusCode: str(record.status) || 'unmapped',
      remark: str(record.message) || message || undefined,
      meterToken: str(record.token) || undefined,
      amountCharged: debited === undefined ? undefined : Money.fromNaira(normaliseAmount(debited)),
      raw: record as Record<string, unknown>,
    };
  }

  // ===========================================================================
  //  Callbacks
  // ===========================================================================

  /**
   * `bill.completed` / `bill.failed`.
   *
   * Verified by `FalconPayWebhookController` before it gets here — these share
   * the transfer webhook URL and secret — so, unlike ClubKonnect's, the status is
   * signed. It is still only as current as the moment it was sent.
   */
  parseCallback(payload: unknown): BillOrderCallback {
    return parseFalconPayBillCallback(payload);
  }

  // ===========================================================================
  //  HTTP
  // ===========================================================================

  /** A read: anything but a clean 2xx envelope throws. */
  private async read<T>(path: string): Promise<T | undefined> {
    return this.unwrap(await this.send<T>('GET', path), path.split('?')[0]!);
  }

  private unwrap<T>(response: FpResponse<T>, operation: string): T | undefined {
    const { status, body } = response;
    if (status >= 200 && status < 300 && body?.success !== false) return body?.data;

    this.logger.error(
      { status, operation, providerMessage: body?.message, providerError: body?.error },
      'FalconPay bills request failed',
    );

    if (status === 429) {
      throw new AppException(ErrorCode.RATE_LIMIT_EXCEEDED, {
        message: 'The bill payment provider is rate limiting us; try again shortly',
        retryable: true,
      });
    }
    if (status === 401 || status === 403 || status === 503) {
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Bill payments are temporarily unavailable. Please try again shortly.',
        details: { providerMessage: body?.message ?? `HTTP ${status}` },
        retryable: status === 503,
      });
    }
    throw new AppException(ErrorCode.UPSTREAM_ERROR, {
      message: 'The bill payment provider rejected the request',
      details: { providerMessage: body?.message ?? `HTTP ${status}` },
      retryable: status >= 500,
    });
  }

  /**
   * One call. Never throws on an HTTP status — callers interpret those — only on
   * a request that got no response at all.
   */
  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<FpResponse<T>> {
    const { baseUrl, secretKey } = this.config.payouts.falconpay;

    if (!secretKey) {
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Bill payments are not configured',
        retryable: false,
      });
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': secretKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.bills.httpTimeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      if (method === 'POST' && path.startsWith('/api/bills/pay')) {
        throw new FalconPayTransportError(timedOut);
      }
      throw new AppException(timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider could not be reached',
        cause,
        retryable: true,
      });
    }

    const parsed = (await response.json().catch(() => null)) as FpEnvelope<T> | T[] | null;
    // Tolerate a bare array/object, as the transfer API sometimes sends.
    const envelope: FpEnvelope<T> | null =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in parsed
        ? parsed
        : parsed === null
          ? null
          : { success: response.ok, data: parsed as T };

    return { status: response.status, headers: response.headers, body: envelope };
  }
}

// =============================================================================
//  Webhooks — exported for the shared FalconPay webhook controller
// =============================================================================

/**
 * Whether a verified FalconPay webhook is about a bill rather than a transfer.
 *
 * One webhook URL per environment serves both, and the payloads carry no common
 * event-type field. A bill event names its `product`; a transfer never does.
 */
export function isFalconPayBillEvent(payload: unknown): boolean {
  const root = (payload ?? {}) as Record<string, unknown>;
  const event = str(root.event ?? root.type ?? root.event_type).toLowerCase();
  if (event.startsWith('bill.')) return true;

  const record = isObject(root.data) ? root.data : root;
  return (
    typeof record.product === 'string' ||
    str(record.transaction_reference).toUpperCase().includes('-BILL')
  );
}

export function parseFalconPayBillCallback(payload: unknown): BillOrderCallback {
  if (!isObject(payload)) {
    throw AppException.validation('Unrecognised bill payment callback payload');
  }

  const root = payload;
  const record = (isObject(root.data) ? root.data : root) as FpBillRecord;
  const event = str(root.event ?? root.type).toLowerCase();

  let status = toBillOrderStatus(record.status, record.settled);
  if (status === BillOrderStatus.Unknown) {
    if (event === 'bill.completed') status = BillOrderStatus.Completed;
    else if (event === 'bill.failed') status = BillOrderStatus.Failed;
  }

  return {
    reference: str(record.reference) || undefined,
    providerOrderId: str(record.transaction_reference) || undefined,
    status,
    statusCode: str(record.status) || event || 'unmapped',
    remark: str(record.message) || undefined,
    raw: record as Record<string, unknown>,
  };
}

/**
 * Their status vocabulary, onto ours.
 *
 * Anything unrecognised is `Unknown`, never `Failed`: failure is what licenses a
 * refund, and a purchase we misread as failed may have delivered.
 */
export function toBillOrderStatus(status: unknown, settled?: boolean): BillOrderStatus {
  switch (str(status).trim().toLowerCase()) {
    case 'completed':
    case 'successful':
    case 'success':
    case 'delivered':
      return BillOrderStatus.Completed;
    case 'failed':
    case 'declined':
      return BillOrderStatus.Failed;
    case 'reversed':
    case 'refunded':
    case 'cancelled':
      return BillOrderStatus.Cancelled;
    case 'processing':
    case 'pending':
    case 'initiated':
    case 'in_flight':
    case 'accepted':
    case 'queued':
      return BillOrderStatus.Processing;
    default:
      return settled === false ? BillOrderStatus.Processing : BillOrderStatus.Unknown;
  }
}

// =============================================================================
//  Helpers
// =============================================================================

function networkFromServiceId(serviceId: string): MobileNetwork | null {
  const id = serviceId.toLowerCase();
  if (id.startsWith('mtn')) return MobileNetwork.Mtn;
  if (id.startsWith('glo')) return MobileNetwork.Glo;
  if (id.startsWith('airtel')) return MobileNetwork.Airtel;
  if (id.startsWith('etisalat') || id.startsWith('9mobile') || id.startsWith('t2')) {
    return MobileNetwork.NineMobile;
  }
  return null;
}

/** `mtn` / `mtn-data`, not `glo-sme-data` or `airtel-corporate-data`. */
function isPlainNetworkService(serviceId: string, product: 'airtime' | 'data'): boolean {
  const pattern =
    product === 'data'
      ? /^(mtn|glo|airtel|etisalat|9mobile|t2)-data$/
      : /^(mtn|glo|airtel|etisalat|9mobile|t2)$/;
  return pattern.test(serviceId.toLowerCase());
}

function cableProviderFromServiceId(serviceId: string): CableProvider | null {
  const id = serviceId.toLowerCase();
  if (id.includes('dstv')) return CableProvider.Dstv;
  if (id.includes('gotv')) return CableProvider.Gotv;
  if (id.includes('startimes')) return CableProvider.Startimes;
  if (id.includes('showmax')) return CableProvider.Showmax;
  return null;
}

function meterVariation(meterType: MeterType): 'prepaid' | 'postpaid' {
  return meterType === MeterType.Postpaid ? 'postpaid' : 'prepaid';
}

function boundsOf(service: FpService): { min: Money; max: Money } {
  return {
    min: Money.fromNaira(normaliseAmount(service.min ?? 0)),
    max: Money.fromNaira(normaliseAmount(service.max ?? 0)),
  };
}

/**
 * FalconPay betting catalogue rows usually have no `min`/`max` fields. Some
 * encode the range in the name (`100 - 50000NGN BETKING DEPOSIT`); open wallets
 * like Sportybet omit both. Match peer billers at ₦100–₦50,000 when unknown.
 */
const DEFAULT_BETTING_MIN_NGN = 100;
const DEFAULT_BETTING_MAX_NGN = 50_000;

function bettingBoundsOf(service: FpService): { min: Money; max: Money } {
  const fromFields = boundsOf(service);
  if (fromFields.max.isPositive()) {
    return {
      min: fromFields.min.isPositive() ? fromFields.min : Money.fromNaira(DEFAULT_BETTING_MIN_NGN),
      max: fromFields.max,
    };
  }

  const fromName = parseAmountRangeFromName(str(service.name));
  if (fromName) {
    return {
      min: Money.fromNaira(fromName.min),
      max: Money.fromNaira(fromName.max),
    };
  }

  return {
    min: Money.fromNaira(DEFAULT_BETTING_MIN_NGN),
    max: Money.fromNaira(DEFAULT_BETTING_MAX_NGN),
  };
}

/** Pulls `100` / `50000` out of names like `NGN100 to 50000NGN BetWay`. */
export function parseAmountRangeFromName(name: string): { min: number; max: number } | null {
  const text = name.replace(/,/g, '');
  const match =
    /(?:NGN\s*)?(\d+)\s*(?:[-–]|to)\s*(?:NGN\s*)?(\d+)/i.exec(text) ??
    /(?:NGN\s*)?(\d+)\s*-\s*(?:NGN\s*)?(\d+)\s*NGN/i.exec(text);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!(min > 0) || !(max >= min)) return null;
  return { min, max };
}

/** A naira amount as a plain two-decimal string. No float ever touches it. */
function normaliseAmount(value: string | number): string {
  const text = (typeof value === 'number' ? value.toFixed(2) : value.trim()).replace(/[,\s₦]/g, '');
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return '0';
  const [, whole = '0', fraction] = match;
  return fraction ? `${whole}.${fraction.slice(0, 2)}` : whole;
}

/** Whole naira, as their JSON number. Fractions are refused, as elsewhere. */
function toNairaNumber(amount: Money): number {
  if (amount.kobo % 100n !== 0n) {
    throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
      message: 'Amount must be a whole number of naira',
      details: { amount: amount.toDecimalString() },
    });
  }
  return Number(amount.kobo / 100n);
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
