import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { PulseMfbClient, PulseMfbHttpError } from '../payments/pulsemfb.client';
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

/** Their `provider` parameter, keyed by our network code. */
const NETWORK_SLUG: Readonly<Record<MobileNetwork, string>> = Object.freeze({
  [MobileNetwork.Mtn]: 'mtn',
  [MobileNetwork.Glo]: 'glo',
  [MobileNetwork.Airtel]: 'airtel',
  [MobileNetwork.NineMobile]: '9mobile',
});

/** The reverse map, for reading their catalogue back. */
const NETWORK_BY_SLUG: ReadonlyMap<string, MobileNetwork> = new Map(
  Object.entries(NETWORK_SLUG).map(([network, slug]) => [slug, network as MobileNetwork]),
);

const NETWORK_NAME: Readonly<Record<MobileNetwork, string>> = Object.freeze({
  [MobileNetwork.Mtn]: 'MTN',
  [MobileNetwork.Glo]: 'Glo',
  [MobileNetwork.Airtel]: 'Airtel',
  [MobileNetwork.NineMobile]: '9Mobile',
});

/**
 * Marks a plan code as Pulse MFB's.
 *
 * Same reasoning as SMEPlug's `sp:` prefix, and it matters more here rather than
 * less: Pulse identifies bundles by a human-looking string (`"1GB-30days"`)
 * that could plausibly collide with another provider's naming. Buying the wrong
 * provider's "1GB" delivers the wrong bundle at a price the customer was never
 * quoted, so codes are namespaced and a bare one is never accepted.
 */
export const PULSEMFB_PLAN_PREFIX = 'pm';

export function encodePlanCode(networkSlug: string, planId: string): string {
  return `${PULSEMFB_PLAN_PREFIX}:${networkSlug}:${planId}`;
}

export function decodePlanCode(code: string): { networkSlug: string; planId: string } | null {
  const parts = code.split(':');
  if (parts.length !== 3 || parts[0] !== PULSEMFB_PLAN_PREFIX) return null;
  const [, networkSlug, planId] = parts;
  if (!networkSlug || !planId) return null;
  return { networkSlug, planId };
}

export function isPulseMfbPlanCode(code: string): boolean {
  return decodePlanCode(code) !== null;
}

/** `GET /accounts/:number/balance` → `data`. */
interface PulseBalanceData {
  available_balance?: number | string;
  ledger_balance?: number | string;
}

/** One entry from `GET /vas/data/bundles`, across the shapes it has been seen in. */
interface PulseBundle {
  id?: string | number;
  code?: string;
  plan_code?: string;
  data_plan?: string;
  name?: string;
  plan?: string;
  description?: string;
  amount?: number | string;
  price?: number | string;
  provider?: string;
  network?: string;
  validity?: string;
}

/** `POST /vas/airtime` and `POST /vas/data` → `data`. */
interface PulseVasData {
  reference?: string;
  status?: string;
  amount?: number | string;
  phone_number?: string;
  provider?: string;
  [key: string]: unknown;
}

/**
 * Pulse MFB adapter — airtime and data only.
 *
 * Implements {@link AirtimeDataProvider} rather than the full `BillsProvider`
 * for the same reason SMEPlug does: Pulse sells no electricity, cable TV or
 * betting, and a type that made those representable would mean five methods
 * existing only to throw. Boot validation refuses `BILLS_PROVIDER=pulsemfb`
 * outright; it is only ever the last tier of the router's airtime/data chain.
 *
 * ## Where this differs from SMEPlug, and why it matters
 *
 * **Orders are not terminal at acceptance.** SMEPlug answers a purchase inline
 * and a `status: true` means delivered. Pulse answers `status: "pending"` and
 * settles later on a `vas.completed` / `vas.failed` webhook. So a successful
 * call here maps to {@link BillOrderStatus.Processing}, never to `Completed`.
 * Reporting delivery at acceptance time would tell a customer their data had
 * landed while the network was still deciding — and would refund nothing when it
 * later failed, because the order would already be terminal.
 *
 * **Its catalogue shape is undocumented.** Pulse publishes
 * `GET /vas/data/bundles` but no example of what it returns, so
 * {@link fetchDataPlans} reads defensively across the field spellings their
 * other endpoints use. Entries it cannot fully understand are skipped rather
 * than guessed at: a plan with an unparseable price would be sold at the wrong
 * price, and a plan with an ambiguous network would be delivered to the wrong
 * one.
 */
@Injectable()
export class PulseMfbVasProvider implements AirtimeDataProvider {
  readonly name = 'pulsemfb';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: PulseMfbClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PulseMfbVasProvider.name);
  }

  // ===========================================================================
  //  Float
  // ===========================================================================

  /**
   * The balance of the account VAS purchases debit.
   *
   * Read from the *account number*, because that is what their balance endpoint
   * is keyed on, while purchases name the same account by its internal id. When
   * only the id is configured there is no way to ask, and the router treats an
   * unavailable balance as "this provider abstains" rather than as an outage.
   */
  async getFloatBalance(): Promise<Money> {
    const accountNumber = this.config.pulsemfb.debitAccountNumber;

    if (!accountNumber) {
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'Pulse MFB float balance is unavailable',
        details: {
          providerMessage:
            'PULSEMFB_DEBIT_ACCOUNT_NUMBER is unset; their balance endpoint is keyed on the NUBAN.',
        },
        retryable: false,
      });
    }

    let data: PulseBalanceData;
    try {
      data = await this.client.get<PulseBalanceData>(`/accounts/${accountNumber}/balance`);
    } catch (error) {
      throw this.toException(error);
    }

    // The *available* balance, not the ledger one: the ledger figure includes
    // funds already committed to transfers that have not yet cleared, and
    // spending against those is how a float goes negative.
    const balance = parseNaira(data.available_balance);

    if (!balance) {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'Pulse MFB did not report a usable account balance',
        retryable: true,
      });
    }

    return balance;
  }

  // ===========================================================================
  //  Catalogue
  // ===========================================================================

  /**
   * Every data bundle Pulse sells.
   *
   * Tolerant of the container shape — an array, `{bundles: []}`, or a map of
   * network to bundles — because their documentation shows none of them. It is
   * *not* tolerant about the contents: a bundle missing a network, an id or a
   * price is skipped and logged, because each of those three decides something
   * a customer is charged for.
   */
  async fetchDataPlans(): Promise<DataPlan[]> {
    let raw: unknown;
    try {
      raw = await this.client.get<unknown>('/vas/data/bundles');
    } catch (error) {
      throw this.toException(error);
    }

    const plans: DataPlan[] = [];
    let skipped = 0;

    for (const [groupKey, bundle] of flattenBundles(raw)) {
      // The network can come from the entry itself or from the key it was filed
      // under. Neither is guaranteed, so both are tried before giving up.
      const slug = normaliseSlug(bundle.provider ?? bundle.network ?? groupKey);
      const network = slug ? NETWORK_BY_SLUG.get(slug) : undefined;

      const planId = firstString(bundle.data_plan, bundle.plan_code, bundle.code, bundle.id);
      const price = parseNaira(bundle.amount ?? bundle.price);
      const name = firstString(bundle.name, bundle.plan, bundle.description);

      if (!network || !planId || !price || !name) {
        skipped += 1;
        continue;
      }

      plans.push({
        network,
        networkName: NETWORK_NAME[network],
        code: encodePlanCode(NETWORK_SLUG[network], planId),
        name: name.trim(),
        price,
      });
    }

    if (skipped > 0) {
      this.logger.warn(
        { skipped, parsed: plans.length },
        'Skipped Pulse MFB bundles missing a network, code, name or price',
      );
    }

    if (plans.length === 0) {
      // An empty catalogue from the last tier is not fatal — the router keeps
      // the other providers' plans — but it does mean this provider will never
      // serve a data order, which is worth saying out loud.
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'Pulse MFB returned no usable data bundles',
        retryable: true,
      });
    }

    return plans;
  }

  // ===========================================================================
  //  Orders
  // ===========================================================================

  async buyAirtime(request: AirtimeOrderRequest): Promise<BillOrder> {
    return this.order(BillVertical.Airtime, '/vas/airtime', request.reference, {
      phone_number: request.phoneNumber,
      amount: this.toNairaAmount(request.amount),
      provider: NETWORK_SLUG[request.network],
      debit_account_id: this.debitAccountId(),
      reference: request.reference,
    });
  }

  async buyData(request: DataOrderRequest): Promise<BillOrder> {
    const decoded = decodePlanCode(request.planCode);
    if (!decoded) {
      // Reaching here means the router sent another provider's plan code. Loud,
      // because delivering *some* bundle would be worse than delivering none.
      throw new AppException(ErrorCode.BILL_PRODUCT_NOT_FOUND, {
        message: 'That data plan is not sold by this provider',
        details: { planCode: request.planCode },
        retryable: false,
      });
    }

    return this.order(BillVertical.Data, '/vas/data', request.reference, {
      phone_number: request.phoneNumber,
      provider: decoded.networkSlug,
      data_plan: decoded.planId,
      debit_account_id: this.debitAccountId(),
      reference: request.reference,
    });
  }

  /**
   * Places one order.
   *
   * A successful response is {@link BillOrderStatus.Processing} — see the class
   * note. The only status treated as terminal here is an explicit failure.
   */
  private async order(
    vertical: BillVertical,
    path: string,
    reference: string,
    body: Record<string, unknown>,
  ): Promise<BillOrder> {
    let data: PulseVasData;
    try {
      data = await this.client.post<PulseVasData>(path, body);
    } catch (error) {
      throw this.toException(error);
    }

    const status = str(data.status).toLowerCase();

    return {
      reference,
      providerOrderId: str(data.reference) || undefined,
      vertical,
      status: toBillStatus(status),
      statusCode: status || 'accepted',
      remark: status ? `Pulse MFB reported "${status}"` : undefined,
      raw: { ...data },
    };
  }

  /** The account VAS purchases debit, as their VAS endpoints name it. */
  private debitAccountId(): string {
    const id = this.config.pulsemfb.debitAccountId;

    if (!id) {
      // Boot validation prevents this in production. Here as a guard for a
      // misconfigured non-production deploy, where the alternative is an opaque
      // upstream rejection on the first customer's airtime purchase.
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'The Pulse MFB bills integration is not configured',
        details: { providerMessage: 'PULSEMFB_DEBIT_ACCOUNT_ID is unset' },
        retryable: false,
      });
    }

    return id;
  }

  /**
   * Converts a kobo amount to the naira their VAS endpoints accept.
   *
   * Airtime is sold in whole naira across every Nigerian network, so a
   * fractional amount here is a bug upstream of this adapter rather than a
   * customer's intent — and truncating it silently would leave the ledger
   * disagreeing with what was delivered.
   */
  private toNairaAmount(amount: Money): number {
    if (!amount.isPositive()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Airtime amount must be greater than zero',
      });
    }

    if (amount.kobo % 100n !== 0n) {
      throw new AppException(ErrorCode.BILL_AMOUNT_NOT_ALLOWED, {
        message: 'Airtime must be a whole number of naira',
        details: { amount: amount.toDecimalString() },
      });
    }

    return Number(amount.kobo / 100n);
  }

  // ===========================================================================
  //  Callbacks
  // ===========================================================================

  /**
   * Normalises a `vas.*` webhook.
   *
   * Unlike SMEPlug's, this callback is **not** advisory: it is the only thing
   * that moves a Pulse order out of `Processing`. A lost one leaves an order
   * indeterminate rather than merely unconfirmed.
   */
  parseCallback(payload: unknown): BillOrderCallback {
    const event = (payload ?? {}) as {
      event?: string;
      data?: Record<string, unknown>;
    };

    const eventType = str(event.event);
    const data = event.data ?? {};
    const status = str(data.status).toLowerCase();

    // The event name is authoritative where it is explicit — `data.status` has
    // been observed still carrying the value from acceptance time.
    const resolved =
      eventType === 'vas.completed'
        ? BillOrderStatus.Completed
        : eventType === 'vas.failed'
          ? BillOrderStatus.Failed
          : toBillStatus(status);

    return {
      reference: str(data.reference) || undefined,
      providerOrderId: str(data.reference) || undefined,
      status: resolved,
      statusCode: status || eventType || 'unknown',
      remark: str(data.narration) || undefined,
      raw: { ...data },
    };
  }

  // ===========================================================================
  //  Errors
  // ===========================================================================

  /**
   * Translates a transport failure into the bills vocabulary.
   *
   * The classification the router acts on is whether the failure says anything
   * about the *request*. A refused phone number will be refused identically
   * anywhere; an exhausted float or an unreachable host will not.
   *
   * Note that Pulse is the **last** tier, so nothing is retried after it — these
   * codes decide the error the customer sees, not where the order goes next.
   */
  private toException(error: unknown): AppException {
    if (error instanceof AppException) return error;

    if (!(error instanceof PulseMfbHttpError)) {
      return new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'Pulse MFB could not be reached',
        cause: error,
        retryable: true,
      });
    }

    const details = { providerMessage: error.providerMessage };

    // An order we never got an answer to. Never reported as failed: a refund on
    // a bundle that was actually delivered is unrecoverable.
    if (error.isUnknownOutcome) {
      return new AppException(ErrorCode.BILL_ORDER_UNKNOWN_OUTCOME, {
        message: 'The order was submitted but its outcome could not be confirmed',
        details,
        cause: error,
        retryable: false,
      });
    }

    if (error.status === 400 && /insufficient balance/i.test(error.providerMessage)) {
      return new AppException(ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED, {
        message: 'The bills provider has insufficient float',
        details,
        retryable: true,
      });
    }

    if (error.status === 429) {
      return new AppException(ErrorCode.RATE_LIMIT_EXCEEDED, {
        message: 'Pulse MFB is rate limiting us; try again shortly',
        details,
        retryable: true,
      });
    }

    if (error.isDefiniteRejection) {
      return new AppException(ErrorCode.BILL_ORDER_REJECTED, {
        message: 'Pulse MFB declined the order',
        details,
        retryable: false,
      });
    }

    return new AppException(
      error.timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR,
      {
        message: 'Pulse MFB could not be reached',
        details,
        cause: error,
        retryable: true,
      },
    );
  }
}

// =============================================================================
//  Helpers
// =============================================================================

/**
 * Maps their VAS status vocabulary onto ours.
 *
 * `pending` is {@link BillOrderStatus.Processing}, not `Pending`: from our side
 * the order has been handed to the network, and the distinction our enum draws
 * is "accepted by us" versus "sent downstream". An unrecognised status is
 * `Unknown` rather than a guess — never a refundable state.
 */
function toBillStatus(status: string): BillOrderStatus {
  switch (status) {
    case 'completed':
    case 'successful':
    case 'success':
      return BillOrderStatus.Completed;
    case 'failed':
    case 'declined':
      return BillOrderStatus.Failed;
    case 'reversed':
    case 'cancelled':
      return BillOrderStatus.Cancelled;
    case 'pending':
    case 'processing':
    case '':
      return BillOrderStatus.Processing;
    default:
      return BillOrderStatus.Unknown;
  }
}

/**
 * Flattens whatever `GET /vas/data/bundles` returned into `[groupKey, bundle]`.
 *
 * Their documentation gives no example, so all three plausible containers are
 * accepted: a bare array, an array under a wrapper key, and a map of network to
 * bundles. The group key is carried through because in the map form it is the
 * only place the network appears.
 */
function flattenBundles(raw: unknown): [string, PulseBundle][] {
  const out: [string, PulseBundle][] = [];

  const pushArray = (key: string, entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry && typeof entry === 'object') out.push([key, entry as PulseBundle]);
    }
  };

  if (Array.isArray(raw)) {
    pushArray('', raw);
    return out;
  }

  if (!raw || typeof raw !== 'object') return out;

  const container = raw as Record<string, unknown>;

  // `{ bundles: [...] }` / `{ plans: [...] }` / `{ data: [...] }`
  for (const key of ['bundles', 'plans', 'data']) {
    if (Array.isArray(container[key])) {
      pushArray('', container[key]);
      return out;
    }
  }

  // `{ mtn: [...], glo: [...] }`
  for (const [key, value] of Object.entries(container)) {
    pushArray(key, value);
  }

  return out;
}

/** Lowercases a network label and strips the punctuation their spellings vary on. */
function normaliseSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const slug = value.toLowerCase().replace(/[\s_-]/g, '');
  return slug || undefined;
}

/** The first of several candidate fields that is a usable non-empty string. */
function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number') return String(candidate);
  }
  return undefined;
}

/**
 * Parses a naira figure into {@link Money}.
 *
 * Stringified and parsed as decimal rather than multiplied by 100: JSON numbers
 * are floats, and `5000.07 * 100` is `500006.9999…`, which truncates to a kobo
 * short on a path where the ledger has to balance exactly.
 */
function parseNaira(value: unknown): Money | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;

  const text = typeof value === 'number' ? value.toFixed(2) : value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;

  try {
    return Money.fromNaira(text);
  } catch {
    return undefined;
  }
}

/** Coerces an untrusted provider field to a string. */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}
