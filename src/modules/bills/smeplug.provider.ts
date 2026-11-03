import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  type AirtimeDataProvider,
  type AirtimeOrderRequest,
  type BillOrder,
  type BillOrderCallback,
  BillOrderStatus,
  BillVertical,
  type DataOrderRequest,
  type DataPlan,
  MobileNetwork,
} from './bills-provider.interface';
import { describe, SP_ENDPOINT, type SpEnvelope, SmePlugClient } from './smeplug.client';

/**
 * SMEPlug's numeric network ids, against our ClubKonnect-shaped enum.
 *
 * Hardcoded rather than read from `GET /networks`. The list is four entries that
 * have not changed since the API was published, and a lookup on the purchase
 * path would add a round trip to every order for a mapping that is effectively
 * constant. If SMEPlug ever renumbers, {@link toNetworkId} throws rather than
 * silently sending airtime to the wrong network.
 */
const NETWORK_ID: Readonly<Record<MobileNetwork, number>> = Object.freeze({
  [MobileNetwork.Mtn]: 1,
  [MobileNetwork.Airtel]: 2,
  [MobileNetwork.NineMobile]: 3,
  [MobileNetwork.Glo]: 4,
});

/** The reverse map, for reading the plan catalogue back. */
const NETWORK_BY_ID: ReadonlyMap<string, MobileNetwork> = new Map(
  Object.entries(NETWORK_ID).map(([network, id]) => [String(id), network as MobileNetwork]),
);

const NETWORK_NAME: Readonly<Record<MobileNetwork, string>> = Object.freeze({
  [MobileNetwork.Mtn]: 'MTN',
  [MobileNetwork.Airtel]: 'Airtel',
  [MobileNetwork.NineMobile]: '9Mobile',
  [MobileNetwork.Glo]: 'Glo',
});

/**
 * Marks a plan code as SMEPlug's.
 *
 * Both providers number their plans from 1, so a bare `"3"` is ambiguous the
 * moment two catalogues are merged — and buying the wrong provider's plan `3`
 * delivers the wrong bundle to a real customer. The prefix carries the network
 * too, so a code is self-describing in a log line.
 */
export const SMEPLUG_PLAN_PREFIX = 'sp';

export function encodePlanCode(networkId: number, planId: string): string {
  return `${SMEPLUG_PLAN_PREFIX}:${networkId}:${planId}`;
}

export function decodePlanCode(code: string): { networkId: string; planId: string } | null {
  const parts = code.split(':');
  if (parts.length !== 3 || parts[0] !== SMEPLUG_PLAN_PREFIX) return null;
  return { networkId: parts[1]!, planId: parts[2]! };
}

export function isSmePlugPlanCode(code: string): boolean {
  return decodePlanCode(code) !== null;
}

interface SpBalance {
  balance?: number | string;
}

interface SpPlan {
  id?: string | number;
  name?: string;
  price?: string | number;
  telco_price?: string | number;
}

/** `data` is keyed by network id, each holding that network's plans. */
type SpPlansResponse = SpEnvelope<Record<string, SpPlan[]>>;

interface SpOrderData {
  reference?: string;
  msg?: string;
  current_status?: string;
}

/** The webhook body. One nested object, no signature — see the controller. */
interface SpWebhookPayload {
  transaction?: {
    status?: string;
    reference?: string;
    customer_reference?: string;
    type?: string;
    beneficiary?: string;
    memo?: string;
    response?: string;
    price?: string | number;
  };
}

/**
 * SMEPlug adapter — airtime and data only.
 *
 * ## Why it leads
 *
 * SMEPlug's SME data bundles are materially cheaper than the reseller rates on
 * the general-purpose aggregator, and airtime and data are the two verticals
 * that carry the volume. It is therefore the default route for both, with the
 * full-service provider behind it — see `RoutedBillsProvider`.
 *
 * ## Ordering is synchronous
 *
 * Unlike ClubKonnect's `100 ORDER_RECEIVED`-then-callback pattern, a SMEPlug
 * purchase answers with the outcome: `status: true` and a reference means the
 * bundle was delivered. The webhook exists to *confirm* that and to report the
 * rare later reversal, not to carry the primary result — which is why
 * {@link buyData} maps a successful response to `Completed` rather than
 * `Processing`.
 */
@Injectable()
export class SmePlugProvider implements AirtimeDataProvider {
  readonly name = 'smeplug';

  constructor(
    private readonly client: SmePlugClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmePlugProvider.name);
  }

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  // ===========================================================================
  //  Float
  // ===========================================================================

  /**
   * Our remaining SMEPlug balance.
   *
   * The one endpoint that does *not* use the `{status, data}` envelope — it
   * returns `{ balance: 3229.12 }` at the top level, as a JSON number. It is
   * converted through a decimal string so the float never reaches a `Money`.
   */
  async getFloatBalance(): Promise<Money> {
    const response = await this.client.get<SpBalance>(SP_ENDPOINT.walletBalance);
    const raw = response.balance;

    if (raw === undefined || raw === null) {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'SMEPlug did not report a wallet balance',
        retryable: true,
      });
    }

    return toMoney(raw);
  }

  // ===========================================================================
  //  Catalogue
  // ===========================================================================

  /**
   * Every data plan SMEPlug sells, flattened out of its per-network map.
   *
   * A network id we do not recognise is skipped rather than guessed at: an
   * unknown id means SMEPlug added a network, and inventing a mapping for it
   * would route real orders to the wrong one.
   */
  async fetchDataPlans(): Promise<DataPlan[]> {
    const response = await this.client.get<SpPlansResponse>(SP_ENDPOINT.dataPlans);

    if (response.status !== true || !response.data) {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'SMEPlug did not return a data catalogue',
        details: { providerMessage: describe(response) ?? 'no plans in response' },
        retryable: true,
      });
    }

    const plans: DataPlan[] = [];

    for (const [networkId, entries] of Object.entries(response.data)) {
      const network = NETWORK_BY_ID.get(networkId);
      if (!network) {
        this.logger.warn({ networkId }, 'SMEPlug returned plans for an unknown network; skipping');
        continue;
      }

      for (const plan of entries ?? []) {
        const id = plan.id === undefined ? undefined : String(plan.id);
        if (!id || !plan.name || plan.price === undefined) continue;

        plans.push({
          network,
          networkName: NETWORK_NAME[network],
          code: encodePlanCode(Number(networkId), id),
          name: plan.name.trim(),
          price: toMoney(plan.price),
        });
      }
    }

    if (plans.length === 0) {
      // An empty catalogue would silently present a customer with no data plans
      // as though none existed.
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'SMEPlug returned an empty data catalogue',
        retryable: true,
      });
    }

    return plans;
  }

  // ===========================================================================
  //  Orders
  // ===========================================================================

  async buyAirtime(request: AirtimeOrderRequest): Promise<BillOrder> {
    const networkId = toNetworkId(request.network);
    const amount = Math.round(Number(request.amount.toDecimalString()));

    // Try /vtu first (Share & Sell devices)
    const vtuResult = await this.orderVtu(request.reference, {
      network_id: networkId,
      phone_number: request.phoneNumber,
      amount,
    });

    // If VTU succeeds, return immediately
    if (vtuResult.status === BillOrderStatus.Completed) {
      return vtuResult;
    }

    // If VTU failed, fallback to /airtime/purchase (Wallet dispense method)
    this.logger.info(
      { reference: request.reference },
      'VTU declined, falling back to /airtime/purchase',
    );
    const body = {
      network_id: networkId,
      phone: request.phoneNumber,
      amount,
      customer_reference: request.reference,
    };

    return this.order(BillVertical.Airtime, SP_ENDPOINT.buyAirtime, request.reference, body);
  }

  async buyData(request: DataOrderRequest): Promise<BillOrder> {
    const decoded = decodePlanCode(request.planCode);
    if (!decoded) {
      // Reaching here means the router sent a ClubKonnect plan code to SMEPlug.
      // Loud, because delivering *some* bundle would be worse than delivering none.
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That data plan is not sold by this provider',
        details: { planCode: request.planCode },
        retryable: false,
      });
    }

    return this.order(BillVertical.Data, SP_ENDPOINT.buyData, request.reference, {
      network_id: Number(decoded.networkId),
      plan_id: Number(decoded.planId),
      phone: request.phoneNumber,
      customer_reference: request.reference,
    });
  }

  /**
   * Places one order.
   *
   * `customer_reference` is our idempotency key on SMEPlug's side and the join
   * key on the webhook — the same value, so a callback that arrives before the
   * HTTP response has been persisted still finds its order.
   */
  private async order(
    vertical: BillVertical,
    path: string,
    reference: string,
    body: Record<string, unknown>,
  ): Promise<BillOrder> {
    const response = await this.client.post<SpEnvelope<SpOrderData>>(path, body);

    if (response.status !== true) {
      // A refusal, not a transport failure: HTTP 200/400 with `status: false`.
      // Terminal and safe to refund — SMEPlug declines *before* delivering.
      let providerMessage = describe(response) ?? 'the order was declined';
      if (
        vertical === BillVertical.Airtime &&
        /unable to purchase airtime/i.test(providerMessage)
      ) {
        providerMessage = 'Unable to purchase Airtime (both VTU and Wallet methods unavailable)';
      }

      this.logger.warn({ vertical, reference, providerMessage }, 'SMEPlug declined an order');

      return {
        reference,
        vertical,
        status: BillOrderStatus.Failed,
        statusCode: 'declined',
        remark: providerMessage,
        raw: response as unknown as Record<string, unknown>,
      };
    }

    const data = response.data ?? {};

    return {
      reference,
      providerOrderId: typeof data.reference === 'string' ? data.reference : undefined,
      vertical,
      // SMEPlug answers with the outcome rather than an acknowledgement, so a
      // `true` status *is* delivery. `current_status` appears on some responses
      // and is honoured when it disagrees.
      status: data.current_status ? mapStatus(data.current_status) : BillOrderStatus.Completed,
      statusCode: data.current_status ?? 'success',
      remark: typeof data.msg === 'string' ? data.msg : undefined,
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * VTU (Virtual Top-Up) fallback for airtime when Wallet dispense method fails.
   *
   * Uses Share & Sell registered devices instead of wallet float. Same response
   * envelope as the standard order endpoint.
   */
  private async orderVtu(reference: string, body: Record<string, unknown>): Promise<BillOrder> {
    const response = await this.client.post<SpEnvelope<SpOrderData>>(
      SP_ENDPOINT.buyAirtimeVtu,
      body,
    );

    if (response.status !== true) {
      const providerMessage = describe(response) ?? 'VTU order was declined';
      this.logger.warn({ reference, providerMessage }, 'SMEPlug VTU order failed');

      return {
        reference,
        vertical: BillVertical.Airtime,
        status: BillOrderStatus.Failed,
        statusCode: 'vtu_declined',
        remark: providerMessage,
        raw: response as unknown as Record<string, unknown>,
      };
    }

    const data = response.data ?? {};

    return {
      reference,
      providerOrderId: typeof data.reference === 'string' ? data.reference : undefined,
      vertical: BillVertical.Airtime,
      status: data.current_status ? mapStatus(data.current_status) : BillOrderStatus.Completed,
      statusCode: data.current_status ?? 'vtu_success',
      remark: typeof data.msg === 'string' ? data.msg : undefined,
      raw: response as unknown as Record<string, unknown>,
    };
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /**
   * Translates the webhook body.
   *
   * `customer_reference` is ours and is what the order is found by;
   * `reference` is SMEPlug's own and is kept for support escalations. A payload
   * carrying neither is unusable — it names no order — and is reported as
   * `Unknown` so the caller records it rather than acting on it.
   */
  parseCallback(payload: unknown): BillOrderCallback {
    const body = (payload ?? {}) as SpWebhookPayload;
    const transaction = body.transaction ?? {};

    const status = typeof transaction.status === 'string' ? transaction.status : '';

    return {
      reference:
        typeof transaction.customer_reference === 'string' && transaction.customer_reference
          ? transaction.customer_reference
          : undefined,
      providerOrderId:
        typeof transaction.reference === 'string' ? transaction.reference : undefined,
      status: status ? mapStatus(status) : BillOrderStatus.Unknown,
      statusCode: status || 'unknown',
      remark:
        typeof transaction.memo === 'string'
          ? transaction.memo
          : typeof transaction.response === 'string'
            ? transaction.response
            : undefined,
      raw: (payload ?? {}) as Record<string, unknown>,
    };
  }
}

/**
 * SMEPlug's status words.
 *
 * Anything unrecognised becomes {@link BillOrderStatus.Unknown} rather than
 * `Failed`: a word we have not seen before is not evidence that a bundle was not
 * delivered, and refunding on it is how a customer keeps both the data and the
 * money.
 */
function mapStatus(status: string): BillOrderStatus {
  switch (status.trim().toLowerCase()) {
    case 'success':
    case 'successful':
    case 'completed':
      return BillOrderStatus.Completed;
    case 'failed':
    case 'declined':
      return BillOrderStatus.Failed;
    case 'refunded':
    case 'reversed':
    case 'cancelled':
      return BillOrderStatus.Cancelled;
    case 'pending':
    case 'processing':
      return BillOrderStatus.Processing;
    default:
      return BillOrderStatus.Unknown;
  }
}

function toNetworkId(network: MobileNetwork): number {
  const id = NETWORK_ID[network];
  if (!id) {
    throw new AppException(ErrorCode.VALIDATION_FAILED, {
      message: 'That network is not supported by this provider',
      details: { network },
      retryable: false,
    });
  }
  return id;
}

/**
 * Naira, however SMEPlug typed it, to {@link Money}.
 *
 * Their JSON mixes `"220"` (string) and `3229.12` (number) for the same kind of
 * value. The number goes through `toFixed(2)` so it becomes a decimal string
 * before `Money` sees it — `Money.fromNaira` refuses fractional numbers
 * precisely to stop a float becoming a balance.
 */
function toMoney(value: string | number): Money {
  const decimal = typeof value === 'number' ? value.toFixed(2) : value.trim();

  try {
    return Money.fromNaira(decimal);
  } catch {
    throw new AppException(ErrorCode.UPSTREAM_ERROR, {
      message: 'SMEPlug returned an amount that could not be read',
      details: { received: String(value).slice(0, 32) },
      retryable: false,
    });
  }
}
