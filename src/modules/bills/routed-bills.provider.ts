import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import type { Money } from '../../core/money/money';
import {
  type AirtimeDataProvider,
  type AirtimeOrderRequest,
  type BettingOrderRequest,
  type BillCatalogue,
  type BillOrder,
  type BillOrderCallback,
  BillOrderStatus,
  type BillsProvider,
  type CableProvider,
  type CableTvOrderRequest,
  type DataOrderRequest,
  type DataPlan,
  type ElectricityOrderRequest,
  type MeterType,
  type VerifiedCustomer,
} from './bills-provider.interface';
import { isPulseMfbPlanCode } from './pulsemfb-vas.provider';
import { isSmePlugPlanCode } from './smeplug.provider';

/**
 * Routes airtime and data to the leading provider, everything else to the
 * full-service one, and falls back when the leader refuses.
 *
 * ## Why a router rather than a second `BILLS_PROVIDER`
 *
 * `BillsService` needs one provider, and the choice of who serves an order is
 * not a deployment-wide setting — it is per-vertical, and per-attempt. Putting
 * that decision in an adapter that satisfies the same interface means the
 * service, the catalogue and every test above it stay unchanged, and the failover
 * policy lives in one readable place instead of as an `if` in five call sites.
 *
 * ## What falls back, and what does not
 *
 * **Airtime falls back freely.** An airtime order is a network and an amount;
 * both providers understand both, so re-placing it downstream delivers exactly
 * what the customer asked for.
 *
 * **Data falls back only when the two catalogues agree.** Plan codes are
 * provider-specific — SMEPlug's plan `3` and ClubKonnect's plan `3` are
 * different bundles — so a blind retry would deliver the wrong thing. The
 * catalogue merge below pairs plans by network, volume and validity, and only a
 * *unique* pairing earns a fallback code. Where the match is ambiguous or
 * missing, the order fails rather than guessing, because "no data" is a
 * complaint and "the wrong bundle, charged at the other one's price" is a
 * dispute.
 *
 * ## When a fallback is attempted
 *
 * Only for failures that say nothing about the customer's request: a timeout, an
 * upstream 5xx, an exhausted float, an outright decline. A validation error — a
 * malformed number, an unsupported network — will fail identically downstream,
 * so it is surfaced immediately rather than spending a second provider call to
 * confirm it.
 */
@Injectable()
export class RoutedBillsProvider implements BillsProvider {
  readonly name: string;

  /**
   * SMEPlug plan code → equivalent ClubKonnect plan code.
   *
   * Rebuilt on every catalogue fetch, which is the only moment both sides are
   * known to be current. Absent entries are the normal case, not an error.
   */
  private fallbackPlanCodes = new Map<string, string>();

  /**
   * Any merged plan code → equivalent code at the last tier.
   *
   * Keyed on codes from *both* providers above, because the last tier backs up
   * both of them. Same uniqueness rule as {@link fallbackPlanCodes}: an
   * ambiguous pairing records nothing.
   */
  private vasFallbackPlanCodes = new Map<string, string>();

  constructor(
    /**
     * The airtime/data specialist that leads, when there is one.
     *
     * Undefined for a deployment that runs the full-service provider on its own
     * and has only added a *trailing* tier — `BILLS_PROVIDER=clubkonnect` with
     * `BILLS_VAS_FALLBACK_PROVIDER=pulsemfb`. There is nothing in front of
     * ClubKonnect there, only something behind it.
     */
    private readonly primary: AirtimeDataProvider | undefined,
    private readonly full: BillsProvider,
    private readonly logger: PinoLogger,
    /**
     * An optional last airtime/data tier, tried after the providers above.
     *
     * Optional because it is genuinely absent by default — the existing chain is
     * the supported baseline, and a deployment that has not configured
     * `BILLS_VAS_FALLBACK_PROVIDER` behaves exactly as it did before this
     * parameter existed.
     */
    private readonly vas?: AirtimeDataProvider,
  ) {
    this.name = [primary?.name, full.name, vas?.name].filter(Boolean).join('+');
    this.logger.setContext(RoutedBillsProvider.name);
  }

  // ===========================================================================
  //  Float
  // ===========================================================================

  /**
   * The larger of the two floats.
   *
   * `BillsService` uses this as a cheap early-out before placing an order, and
   * with a fallback in place the honest answer to "can this be funded?" is yes
   * when *either* provider can fund it. The interface already states that the
   * figure is advisory and the provider remains the authority, which is what
   * covers the one case this over-reports: a ClubKonnect-only vertical admitted
   * on the strength of SMEPlug's balance. That order then fails at ClubKonnect
   * with a float error rather than being refused here — a worse error message,
   * not a worse outcome, and the alternative (reporting the minimum) would block
   * airtime that SMEPlug is perfectly able to serve.
   */
  async getFloatBalance(): Promise<Money> {
    const results = await Promise.allSettled([
      ...(this.primary ? [this.primary.getFloatBalance()] : []),
      this.full.getFloatBalance(),
      ...(this.vas ? [this.vas.getFloatBalance()] : []),
    ]);

    const balances = results
      .filter((result): result is PromiseFulfilledResult<Money> => result.status === 'fulfilled')
      .map((result) => result.value);

    if (balances.length === 0) {
      // Failing open here would defeat the point of the check entirely.
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'No bills provider would report its balance',
        retryable: true,
      });
    }

    return balances.reduce((best, balance) => (balance.greaterThan(best) ? balance : best));
  }

  // ===========================================================================
  //  Catalogue
  // ===========================================================================

  /**
   * The merged catalogue: SMEPlug's data plans in front, everything else from
   * the full provider.
   *
   * The leader's plans win on price and are the ones customers see. ClubKonnect
   * plans with no SMEPlug equivalent are appended rather than dropped — losing a
   * bundle a customer could previously buy is a worse regression than showing
   * one that costs a little more.
   */
  async fetchCatalogue(): Promise<BillCatalogue> {
    const [primaryPlans, fullCatalogue, vasPlans] = await Promise.allSettled([
      this.primary ? this.primary.fetchDataPlans() : Promise.resolve<DataPlan[]>([]),
      this.full.fetchCatalogue(),
      this.vas ? this.vas.fetchDataPlans() : Promise.resolve<DataPlan[]>([]),
    ]);

    if (fullCatalogue.status === 'rejected') {
      // Electricity, cable and betting have no second source. Without this
      // catalogue there is nothing to sell in three of five verticals.
      throw fullCatalogue.reason instanceof Error
        ? fullCatalogue.reason
        : new AppException(ErrorCode.UPSTREAM_ERROR, {
            message: 'The bills catalogue could not be loaded',
            retryable: true,
          });
    }

    const base = fullCatalogue.value;

    if (primaryPlans.status === 'rejected') {
      // Degraded, not broken: sell the fallback provider's plans until the
      // leader recovers.
      this.logger.warn(
        { err: reasonText(primaryPlans.reason) },
        'Leading provider returned no data plans; serving the fallback catalogue only',
      );
      this.fallbackPlanCodes = new Map();
      this.vasFallbackPlanCodes = new Map();
      return base;
    }

    const { plans, equivalents } = mergeDataPlans(primaryPlans.value, base.dataPlans);
    this.fallbackPlanCodes = equivalents;

    // The last tier is folded in against the *already merged* list, so its
    // equivalence map covers both providers above it — either can fall through
    // to it. Its own unpaired plans are appended, so a bundle only it sells is
    // still sellable.
    const vasCatalogue = vasPlans.status === 'fulfilled' ? vasPlans.value : [];

    if (vasPlans.status === 'rejected' && this.vas) {
      // Not fatal: the chain above is intact and keeps selling. It does mean the
      // last tier can serve no data order until its catalogue returns, which is
      // worth a line in the log rather than silence.
      this.logger.warn(
        { err: reasonText(vasPlans.reason) },
        'Last-tier provider returned no data plans; data orders will not fall through to it',
      );
    }

    const merged = mergeDataPlans(plans, vasCatalogue);
    this.vasFallbackPlanCodes = merged.equivalents;

    this.logger.info(
      {
        primary: primaryPlans.value.length,
        fallback: base.dataPlans.length,
        vas: vasCatalogue.length,
        merged: merged.plans.length,
        pairedForFallback: equivalents.size,
        pairedForVasFallback: merged.equivalents.size,
      },
      'Merged data catalogues',
    );

    return { ...base, dataPlans: merged.plans };
  }

  // ===========================================================================
  //  Orders
  // ===========================================================================

  async buyAirtime(request: AirtimeOrderRequest): Promise<BillOrder> {
    const { primary, vas } = this;

    // Same network, same amount, same reference at every tier. An airtime order
    // is a network and a number; nothing is reinterpreted on the way down.
    return this.withFallback('airtime', request.reference, [
      ...(primary ? [() => primary.buyAirtime(request)] : []),
      () => this.full.buyAirtime(request),
      ...(vas ? [() => vas.buyAirtime(request)] : []),
    ]);
  }

  async buyData(request: DataOrderRequest): Promise<BillOrder> {
    const { primary, vas } = this;
    const vasEquivalent = this.vasFallbackPlanCodes.get(request.planCode);

    // A code the last tier owns was never paired with anything above it — that
    // is what being in the merged catalogue under its own code means — so there
    // is nowhere else to send it.
    if (vas && isPulseMfbPlanCode(request.planCode)) {
      return vas.buyData(request);
    }

    // A plan the customer chose from the full provider's half of the catalogue
    // was never the leader's to sell, but the last tier may still stock an
    // equivalent.
    if (!primary || !isSmePlugPlanCode(request.planCode)) {
      return this.withFallback('data', request.reference, [
        () => this.full.buyData(request),
        ...(vas && vasEquivalent
          ? [() => vas.buyData({ ...request, planCode: vasEquivalent })]
          : []),
      ]);
    }

    const equivalent = this.fallbackPlanCodes.get(request.planCode);

    // Each tier is attempted only under a plan code *it* sells, and only where
    // the pairing was unambiguous. A tier with no confident equivalent is
    // skipped rather than sent a code it would misread: better a clean failure
    // than a different bundle at a price the customer was not quoted.
    return this.withFallback('data', request.reference, [
      () => primary.buyData(request),
      ...(equivalent ? [() => this.full.buyData({ ...request, planCode: equivalent })] : []),
      ...(vas && vasEquivalent ? [() => vas.buyData({ ...request, planCode: vasEquivalent })] : []),
    ]);
  }

  /**
   * Walks the tier chain until one delivers, or the reason to keep going runs
   * out.
   *
   * Two kinds of "no" move the order down the chain, and they are not the same
   * thing. A **thrown error** is a provider that could not answer — a timeout, a
   * 5xx, an exhausted float — and only some of those are worth re-placing
   * ({@link isWorthRetrying}). A **`Failed` order** is a provider that answered
   * and refused; that is always worth another tier, because the refusal is
   * itself proof nothing was delivered.
   *
   * What the caller finally sees depends on how the chain ended. A structured
   * refusal outranks a thrown error: if any tier declined cleanly, that decline
   * is returned rather than a later tier's transport failure, because it is the
   * more specific and more explicable fact. Only when *no* tier managed a clean
   * answer does an exception propagate.
   */
  private async withFallback(
    vertical: string,
    reference: string,
    attempts: (() => Promise<BillOrder>)[],
  ): Promise<BillOrder> {
    /** The first clean refusal seen, kept as the answer of last resort. */
    let declined: BillOrder | undefined;
    let lastError: unknown;

    for (const [index, attempt] of attempts.entries()) {
      const isLast = index === attempts.length - 1;

      let order: BillOrder;
      try {
        order = await attempt();
      } catch (error) {
        lastError = error;

        // A failure that says something about the *request* will say the same
        // thing downstream. Stop, unless we already hold a cleaner answer.
        if (!isWorthRetrying(error)) break;

        this.logger.warn(
          {
            vertical,
            reference,
            tier: index,
            err: error instanceof Error ? error.message : String(error),
          },
          'Bills provider failed; trying the next tier',
        );
        continue;
      }

      if (order.status !== BillOrderStatus.Failed) return order;

      // Answered and refused. Remember the first such refusal — it is the most
      // customer-legible explanation available — and keep going.
      declined ??= order;

      if (isLast) return order;

      this.logger.warn(
        { vertical, reference, tier: index, remark: order.remark },
        'Bills provider declined the order; trying the next tier',
      );
    }

    if (declined) {
      this.logger.warn(
        { vertical, reference },
        'Every bills tier refused; returning the first structured refusal',
      );
      return declined;
    }

    // No tier produced a `BillOrder` at all. There is nothing to return but the
    // last failure — and swallowing it into a synthetic "failed" order would
    // mark as refundable an order whose outcome nobody actually knows.
    throw lastError instanceof Error
      ? lastError
      : new AppException(ErrorCode.UPSTREAM_ERROR, {
          message: 'No bills provider could serve this order',
          retryable: true,
        });
  }

  // ===========================================================================
  //  Delegated wholesale — verticals the leader does not sell
  // ===========================================================================

  async verifyMeter(
    discoCode: string,
    meterNumber: string,
    meterType: MeterType,
  ): Promise<VerifiedCustomer> {
    return this.full.verifyMeter(discoCode, meterNumber, meterType);
  }

  async verifySmartCard(
    provider: CableProvider,
    smartCardNumber: string,
  ): Promise<VerifiedCustomer> {
    return this.full.verifySmartCard(provider, smartCardNumber);
  }

  async verifyBettingCustomer(companyCode: string, customerId: string): Promise<VerifiedCustomer> {
    return this.full.verifyBettingCustomer(companyCode, customerId);
  }

  async payElectricity(request: ElectricityOrderRequest): Promise<BillOrder> {
    return this.full.payElectricity(request);
  }

  async subscribeCableTv(request: CableTvOrderRequest): Promise<BillOrder> {
    return this.full.subscribeCableTv(request);
  }

  async fundBetting(request: BettingOrderRequest): Promise<BillOrder> {
    return this.full.fundBetting(request);
  }

  /**
   * Re-reads an order.
   *
   * Routed to the full provider: the leader answers synchronously and has no
   * query endpoint integrated, so anything still indeterminate long enough to
   * need a re-read went downstream.
   */
  async queryOrder(params: { reference?: string; providerOrderId?: string }): Promise<BillOrder> {
    return this.full.queryOrder(params);
  }

  /**
   * Parses a callback from the full provider.
   *
   * SMEPlug's webhook has its own controller and its own parser — the two
   * payloads share no fields, and a single `parseCallback` that had to guess
   * which provider sent a body would be guessing about money.
   */
  parseCallback(payload: unknown): BillOrderCallback {
    return this.full.parseCallback(payload);
  }
}

/** A rejection reason as a log-safe string. `PromiseRejectedResult.reason` is `any`. */
function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Whether a failed attempt is worth re-placing downstream.
 *
 * The question is not "did it fail?" but "does this failure tell us anything
 * about the request?". A timeout, a 5xx or an exhausted float say nothing —
 * another provider may well succeed. A rejected phone number or an unknown plan
 * will be rejected identically downstream, and spending a second provider call
 * to confirm it just makes the customer wait longer for the same answer.
 */
function isWorthRetrying(error: unknown): boolean {
  if (!(error instanceof AppException)) return true;

  switch (error.code) {
    case ErrorCode.UPSTREAM_TIMEOUT:
    case ErrorCode.UPSTREAM_ERROR:
    case ErrorCode.SERVICE_UNAVAILABLE:
    case ErrorCode.CIRCUIT_OPEN:
    case ErrorCode.BILL_PROVIDER_FLOAT_EXHAUSTED:
    case ErrorCode.BILL_ORDER_REJECTED:
      return true;
    default:
      return false;
  }
}

/**
 * Merges two data catalogues and works out which plans are interchangeable.
 *
 * Pairing is on (network, volume in MB, validity in days). Both sides must parse
 * and both must agree, and the match must be **unique** — where a bare "1GB"
 * from one catalogue could be either the 7-day or the 30-day "1GB" in the other,
 * there is no safe answer, so no pairing is recorded and that plan simply does
 * not fall back.
 */
export function mergeDataPlans(
  primary: DataPlan[],
  fallback: DataPlan[],
): { plans: DataPlan[]; equivalents: Map<string, string> } {
  const byKey = new Map<string, DataPlan[]>();

  for (const plan of fallback) {
    const key = planKey(plan);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(plan);
    else byKey.set(key, [plan]);
  }

  const equivalents = new Map<string, string>();
  const paired = new Set<string>();

  for (const plan of primary) {
    const key = planKey(plan);
    if (!key) continue;

    const candidates = byKey.get(key);
    // Exactly one, or none. Two candidates means the names do not carry enough
    // to tell them apart, which is precisely when guessing is most expensive.
    if (candidates?.length !== 1) continue;

    equivalents.set(plan.code, candidates[0]!.code);
    paired.add(candidates[0]!.code);
  }

  // The leader's plans first — they are what a customer sees and buys — then any
  // fallback plan that has no equivalent, so nothing sellable disappears.
  const plans = [...primary, ...fallback.filter((plan) => !paired.has(plan.code))];

  return { plans, equivalents };
}

/** `network:volumeMb:validityDays`, or null when the name cannot be read. */
function planKey(plan: DataPlan): string | null {
  const volume = parseVolumeMb(plan.name);
  if (volume === null) return null;
  return `${plan.network}:${volume}:${parseValidityDays(plan.name) ?? 'any'}`;
}

/** Volume in megabytes. Understands `500MB`, `1.5GB`, `1 GB`, `40GB`. */
export function parseVolumeMb(name: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i.exec(name);
  if (!match) return null;

  const size = Number.parseFloat(match[1]!);
  if (!Number.isFinite(size) || size <= 0) return null;

  switch (match[2]!.toUpperCase()) {
    case 'TB':
      return Math.round(size * 1024 * 1024);
    case 'GB':
      return Math.round(size * 1024);
    default:
      return Math.round(size);
  }
}

/**
 * Validity in days, or null when the name does not state one.
 *
 * Null is a real value here, not a failure — most SMEPlug names carry no
 * validity at all — and it participates in the key so that a bare plan pairs
 * only with another bare plan, never with a dated one.
 */
export function parseValidityDays(name: string): number | null {
  const explicit = /(\d+)\s*(?:-|\s)?\s*(day|days|dy)\b/i.exec(name);
  if (explicit) {
    const days = Number.parseInt(explicit[1]!, 10);
    return Number.isFinite(days) && days > 0 ? days : null;
  }

  if (/\bmonthly\b|\b1\s*month\b/i.test(name)) return 30;
  if (/\bweekly\b/i.test(name)) return 7;
  if (/\bdaily\b/i.test(name)) return 1;
  if (/\byearly\b|\bannual\b/i.test(name)) return 365;

  const months = /(\d+)\s*months?\b/i.exec(name);
  if (months) {
    const count = Number.parseInt(months[1]!, 10);
    return Number.isFinite(count) && count > 0 ? count * 30 : null;
  }

  return null;
}
