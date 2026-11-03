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
  type MobileNetwork,
  type VerifiedCustomer,
} from './bills-provider.interface';
import { CK_ENDPOINT, ClubKonnectClient, type CkParams } from './clubkonnect.client';
import { isVerificationFailure, remarkForCode, toBillOrderStatus } from './clubkonnect.status';
import type {
  CkBettingResponse,
  CkCablePackagesResponse,
  CkCallbackPayload,
  CkDataPlansResponse,
  CkDiscosResponse,
  CkOrderResponse,
  CkVerifyResponse,
  CkWalletBalance,
} from './clubkonnect.types';

/**
 * ClubKonnect adapter.
 *
 * Everything provider-specific lives here: `01`-style network codes, naira
 * strings, the numeric status vocabulary, the nested catalogue shapes, and the
 * fact that a failed verification arrives as a 200 with the failure written into
 * the name field.
 *
 * The class holds no state and does no caching — {@link BillsCatalogueService}
 * decides how stale a catalogue may be, which is a policy question and not the
 * adapter's to answer.
 */
@Injectable()
export class ClubKonnectProvider implements BillsProvider {
  readonly name = 'clubkonnect';

  constructor(
    private readonly client: ClubKonnectClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ClubKonnectProvider.name);
  }

  // ===========================================================================
  //  Float
  // ===========================================================================

  /**
   * Our remaining balance with ClubKonnect, in naira.
   *
   * This is the reseller float that every order is drawn against — not a
   * customer's wallet. When it runs out, every vertical stops at once.
   */
  async getFloatBalance(): Promise<Money> {
    const response = await this.client.get<CkWalletBalance>(CK_ENDPOINT.walletBalance, {});

    if (response.balance === undefined) {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The bill payment provider did not report a balance',
        retryable: true,
      });
    }

    // Arrives as a naira decimal string. `Money.fromNaira` parses it exactly —
    // going via `Number` here would put float rounding on the balance that gates
    // every purchase.
    return Money.fromNaira(normaliseAmount(response.balance));
  }

  // ===========================================================================
  //  Catalogue
  // ===========================================================================

  /**
   * Fetches all four catalogues concurrently.
   *
   * They are independent, and serially this is four slow round trips. One
   * failure fails the whole snapshot on purpose: a partial catalogue would
   * silently present a customer with no data plans as though none existed.
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
    // The catalogue endpoints take a UserID only; sending an APIKey is rejected.
    const response = await this.client.get<CkDataPlansResponse>(
      CK_ENDPOINT.dataPlans,
      {},
      { withApiKey: false },
    );

    const plans: DataPlan[] = [];

    for (const [networkName, entries] of Object.entries(response.MOBILE_NETWORK ?? {})) {
      for (const entry of entries ?? []) {
        const network = entry.ID?.trim();
        if (!network) continue;

        for (const product of entry.PRODUCT ?? []) {
          // `PRODUCT_ID` — not `PRODUCT_CODE` — is the value the purchase
          // endpoint accepts as `DataPlan`.
          const code = product.PRODUCT_ID?.trim();
          const price = product.PRODUCT_AMOUNT;
          if (!code || price === undefined) continue;

          plans.push({
            network: network as MobileNetwork,
            networkName,
            code,
            name: product.PRODUCT_NAME?.trim() ?? code,
            price: Money.fromNaira(normaliseAmount(price)),
          });
        }
      }
    }

    return plans;
  }

  private async fetchCablePackages(): Promise<CablePackage[]> {
    const response = await this.client.get<CkCablePackagesResponse>(
      CK_ENDPOINT.cablePackages,
      {},
      { withApiKey: false },
    );

    const packages: CablePackage[] = [];

    for (const entries of Object.values(response.TV_ID ?? {})) {
      for (const entry of entries ?? []) {
        const provider = entry.ID?.trim().toLowerCase();
        if (!provider) continue;

        for (const item of entry.PRODUCT ?? []) {
          const code = item.PACKAGE_ID?.trim();
          if (!code || item.PACKAGE_AMOUNT === undefined) continue;

          const price = Money.fromNaira(normaliseAmount(item.PACKAGE_AMOUNT));

          packages.push({
            provider: provider as CableProvider,
            code,
            name: item.PACKAGE_NAME?.trim() ?? code,
            price,
            // The discounted figure is what our float is charged. Falling back to
            // list price is the conservative choice: it can only overstate cost,
            // which makes the float check stricter rather than looser.
            costPrice:
              item.PRODUCT_DISCOUNT_AMOUNT === undefined
                ? price
                : Money.fromNaira(normaliseAmount(item.PRODUCT_DISCOUNT_AMOUNT)),
            bounds: {
              min: Money.fromNaira(normaliseAmount(item.MINAMOUNT ?? 0)),
              max: Money.fromNaira(normaliseAmount(item.MAXAMOUNT ?? 0)),
            },
          });
        }
      }
    }

    return packages;
  }

  private async fetchDiscos(): Promise<ElectricityDisco[]> {
    const response = await this.client.get<CkDiscosResponse>(
      CK_ENDPOINT.discos,
      {},
      { withApiKey: false },
    );

    const discos: ElectricityDisco[] = [];

    for (const entries of Object.values(response.ELECTRIC_COMPANY ?? {})) {
      for (const entry of entries ?? []) {
        const code = entry.ID?.trim();
        if (!code) continue;

        const products = entry.PRODUCT ?? [];
        const meterTypes = products
          .map((product) => product.PRODUCT_ID?.trim())
          .filter((id): id is string => id === MeterType.Prepaid || id === MeterType.Postpaid)
          .map((id) => id as MeterType);

        const first = products[0];

        discos.push({
          code,
          name: entry.NAME?.trim() ?? code,
          meterTypes,
          bounds: {
            min: Money.fromNaira(normaliseAmount(first?.MINAMOUNT ?? 0)),
            max: Money.fromNaira(normaliseAmount(first?.MAXAMOUNT ?? 0)),
          },
        });
      }
    }

    return discos;
  }

  private async fetchBettingCompanies(): Promise<BettingCompany[]> {
    const response = await this.client.get<CkBettingResponse>(
      CK_ENDPOINT.bettingCompanies,
      {},
      { withApiKey: false },
    );

    const companies: BettingCompany[] = [];

    for (const item of response.BETTING_COMPANY ?? []) {
      const code = item.PRODUCT_CODE?.trim();
      if (!code) continue;

      companies.push({
        code,
        name: item.PRODUCT_NAME?.trim() ?? code,
        bounds: {
          min: Money.fromNaira(normaliseAmount(item.MINAMOUNT ?? 0)),
          max: Money.fromNaira(normaliseAmount(item.MAXAMOUNT ?? 0)),
        },
      });
    }

    return companies;
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
      CK_ENDPOINT.verifyElectricity,
      { ElectricCompany: discoCode, MeterNo: meterNumber, MeterType: meterType },
      meterNumber,
      'meter number',
    );
  }

  async verifySmartCard(
    provider: CableProvider,
    smartCardNumber: string,
  ): Promise<VerifiedCustomer> {
    return this.verify(
      CK_ENDPOINT.verifyCableTv,
      { CableTV: provider, SmartCardNo: smartCardNumber },
      smartCardNumber,
      'smartcard number',
    );
  }

  async verifyBettingCustomer(companyCode: string, customerId: string): Promise<VerifiedCustomer> {
    return this.verify(
      CK_ENDPOINT.verifyBetting,
      { BettingCompany: companyCode, CustomerID: customerId },
      customerId,
      'customer ID',
    );
  }

  /**
   * One name lookup.
   *
   * The critical detail: a failed lookup is HTTP 200 with a success-shaped body
   * whose `customer_name` holds the error (`INVALID_METERNO`, `Error, Invalid
   * Customer ID`). Returning that verbatim would show the customer a "name" of
   * `INVALID_METERNO` and let the order proceed against a meter that does not
   * exist — money the customer never gets back.
   */
  private async verify(
    endpoint: string,
    params: CkParams,
    identifier: string,
    label: string,
  ): Promise<VerifiedCustomer> {
    const response = await this.client.get<CkVerifyResponse>(endpoint, params);
    const name = response.customer_name?.trim() ?? '';

    if (isVerificationFailure(name)) {
      throw new AppException(ErrorCode.BILL_CUSTOMER_INVALID, {
        message: `That ${label} could not be verified. Please check it and try again.`,
        details: { providerResponse: name || 'empty' },
      });
    }

    return { identifier, name };
  }

  // ===========================================================================
  //  Orders
  // ===========================================================================

  async buyAirtime(request: AirtimeOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.Airtime, CK_ENDPOINT.airtime, request.reference, {
      MobileNetwork: request.network,
      Amount: toNairaParam(request.amount),
      MobileNumber: request.phoneNumber,
    });
  }

  async buyData(request: DataOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.Data, CK_ENDPOINT.data, request.reference, {
      MobileNetwork: request.network,
      DataPlan: request.planCode,
      MobileNumber: request.phoneNumber,
    });
  }

  async payElectricity(request: ElectricityOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.Electricity, CK_ENDPOINT.electricity, request.reference, {
      ElectricCompany: request.discoCode,
      MeterType: request.meterType,
      MeterNo: request.meterNumber,
      Amount: toNairaParam(request.amount),
      PhoneNo: request.phoneNumber,
    });
  }

  async subscribeCableTv(request: CableTvOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.CableTv, CK_ENDPOINT.cableTv, request.reference, {
      CableTV: request.provider,
      Package: request.packageCode,
      SmartCardNo: request.smartCardNumber,
      PhoneNo: request.phoneNumber,
    });
  }

  async fundBetting(request: BettingOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.Betting, CK_ENDPOINT.betting, request.reference, {
      BettingCompany: request.companyCode,
      CustomerID: request.customerId,
      Amount: toNairaParam(request.amount),
    });
  }

  /**
   * Places one order.
   *
   * `RequestID` is our reference and is what makes a retry safe: ClubKonnect
   * rejects a second use of it rather than delivering twice. `CallBackURL` is
   * sent per request rather than configured once with the provider, which is how
   * their API works.
   */
  private async order(
    vertical: BillVertical,
    endpoint: string,
    reference: string,
    params: CkParams,
  ): Promise<BillOrder> {
    const callbackUrl = this.config.bills.clubkonnect.callbackUrl;

    const response = await this.client.get<CkOrderResponse>(endpoint, {
      ...params,
      RequestID: reference,
      CallBackURL: callbackUrl || undefined,
    });

    const order = this.toBillOrder(vertical, reference, response);

    this.logger.info(
      {
        vertical,
        reference,
        providerOrderId: order.providerOrderId,
        statusCode: order.statusCode,
        status: order.status,
      },
      'ClubKonnect order placed',
    );

    return order;
  }

  async queryOrder(params: { reference?: string; providerOrderId?: string }): Promise<BillOrder> {
    if (!params.reference && !params.providerOrderId) {
      throw AppException.validation('An order reference or provider order id is required');
    }

    const response = await this.client.get<CkOrderResponse>(CK_ENDPOINT.query, {
      OrderID: params.providerOrderId,
      RequestID: params.providerOrderId ? undefined : params.reference,
    });

    return this.toBillOrder(
      verticalFromOrderType(response.ordertype),
      params.reference ?? response.requestid ?? '',
      response,
    );
  }

  /** Normalises an order or query response into our vocabulary. */
  private toBillOrder(
    vertical: BillVertical,
    reference: string,
    response: CkOrderResponse,
  ): BillOrder {
    const statusCode = response.statuscode?.trim() ?? '';
    const status = toBillOrderStatus(statusCode);

    if (status === BillOrderStatus.Unknown) {
      // Worth a log line of its own: an unmapped code is either a provider
      // change or a case the status table has not seen, and both need a human.
      this.logger.warn(
        { reference, statusCode, providerStatus: response.status },
        'ClubKonnect returned a status code we cannot classify',
      );
    }

    return {
      reference: reference || response.requestid?.trim() || '',
      providerOrderId: response.orderid?.trim() || undefined,
      vertical,
      status,
      statusCode,
      remark: response.remark?.trim() || remarkForCode(statusCode),
      meterToken: response.metertoken?.trim() || undefined,
      amountCharged:
        response.amountcharged === undefined
          ? undefined
          : Money.fromNaira(normaliseAmount(response.amountcharged)),
      raw: response as unknown as Record<string, unknown>,
    };
  }

  // ===========================================================================
  //  Callbacks
  // ===========================================================================

  /**
   * Parses a status callback.
   *
   * ClubKonnect authenticates these with nothing at all — there is no signature
   * and no shared secret in their design. A callback is therefore treated as a
   * *hint* that something changed, never as proof: the caller must confirm the
   * new state with {@link queryOrder} before acting on it. Trusting this payload
   * as-is would let anyone who learns an order id mark it completed.
   */
  parseCallback(payload: unknown): BillOrderCallback {
    if (typeof payload !== 'object' || payload === null) {
      throw AppException.validation('Unrecognised bill payment callback payload');
    }

    const event = payload as CkCallbackPayload;
    const statusCode = event.statuscode?.trim() ?? '';

    return {
      reference: event.requestid?.trim() || undefined,
      providerOrderId: event.orderid?.trim() || undefined,
      status: toBillOrderStatus(statusCode),
      statusCode,
      remark: event.orderremark?.trim() || remarkForCode(statusCode),
      raw: event as unknown as Record<string, unknown>,
    };
  }
}

// =============================================================================
//  Coercion helpers
// =============================================================================

/**
 * Normalises a provider amount into something {@link Money.fromNaira} accepts.
 *
 * The catalogues are inconsistent: `MINAMOUNT` is a JSON number, `PRODUCT_AMOUNT`
 * is `"307"`, `PACKAGE_AMOUNT` is `"4400.00"`, and balances arrive with thousands
 * separators often enough to matter. Everything is reduced to a plain decimal
 * string so no float ever touches an amount.
 */
function normaliseAmount(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const stripped = text.replace(/[,\s₦]/g, '');

  // `Money.fromNaira` allows at most 2 decimal places; the provider occasionally
  // sends more. Truncating (rather than rounding) keeps a cost estimate from
  // drifting upward, and the sub-kobo tail is meaningless in any case.
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(stripped);
  if (!match) return stripped;

  const [, whole = '0', fraction] = match;
  return fraction ? `${whole}.${fraction.slice(0, 2)}` : whole;
}

/**
 * Formats a {@link Money} as the `Amount` query parameter.
 *
 * ClubKonnect expects whole naira. A fractional amount would be truncated
 * upstream in a way we could not predict, so it is rejected here instead.
 */
function toNairaParam(amount: Money): string {
  if (amount.kobo % 100n !== 0n) {
    throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
      message: 'Amount must be a whole number of naira',
      details: { amount: amount.toDecimalString() },
    });
  }
  return String(amount.kobo / 100n);
}

/** Best-effort vertical from the `ordertype` a query response carries. */
function verticalFromOrderType(orderType: string | undefined): BillVertical {
  const value = orderType?.trim().toUpperCase() ?? '';

  if (value.includes('DATA')) return BillVertical.Data;
  if (value.includes('ELECTRIC') || value.includes('POWER')) return BillVertical.Electricity;
  if (value.includes('TV') || value.includes('DSTV') || value.includes('GOTV')) {
    return BillVertical.CableTv;
  }
  if (value.includes('BET')) return BillVertical.Betting;
  return BillVertical.Airtime;
}
