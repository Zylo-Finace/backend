import type { PayoutProviderName } from '@prisma/client';
import { type PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import {
  type Bank,
  type NormalisedPayoutEvent,
  type PayoutAcceptance,
  type PayoutProvider,
  type PayoutRequest,
  type ResolvedAccount,
} from './payout-provider.interface';

/**
 * Sends transfers through the primary provider and re-places them downstream
 * when — and only when — the primary definitely did not accept them.
 *
 * ## Why failover here is so much narrower than on bills
 *
 * `RoutedBillsProvider` falls back on any failure that says nothing about the
 * request, timeouts included. That is safe there because a bills provider will
 * reject a duplicate `RequestID`, so the worst case of a spurious retry is a
 * rejection.
 *
 * None of that holds for a NIP transfer. Our reference is idempotent *within* a
 * provider, but the fallback is a **different company**: it has never seen the
 * reference, and it will happily send the money again. If the primary timed out
 * having actually queued the transfer, a fallback attempt sends it twice — to a
 * real person, irreversibly, with the customer debited once.
 *
 * So the rule is not "did it fail?" but **"do we know for certain that nothing
 * was queued?"**, and only a small set of answers clears that bar:
 *
 * | Primary's answer            | Fall back? | Why                                        |
 * |-----------------------------|------------|--------------------------------------------|
 * | `PAYOUT_REJECTED` (4xx)     | yes        | They considered it and refused. Nothing queued. |
 * | `SERVICE_UNAVAILABLE`       | yes        | Not configured, or float exhausted. Never reached NIBSS. |
 * | `CIRCUIT_OPEN`              | yes        | We never sent it.                           |
 * | `PAYOUT_UNKNOWN_OUTCOME`    | **no**     | It may be in flight. This is the whole point. |
 * | `UPSTREAM_TIMEOUT`          | **no**     | Same — no answer is not the same as "no".   |
 * | `UPSTREAM_ERROR` (5xx)      | **no**     | Their server broke *while handling it*; state unknown. |
 * | `PAYOUT_DUPLICATE_REFERENCE`| **no**     | Already submitted. Leave it alone.          |
 * | `VALIDATION_FAILED`         | **no**     | Will fail identically downstream.           |
 *
 * A 5xx being non-retryable here is the one that looks wrong at first glance. It
 * is deliberate: a 500 from a transfer endpoint means the request reached their
 * application, and whether it reached NIBSS before breaking is exactly what we
 * cannot know.
 *
 * ## What is *not* routed
 *
 * `listBanks` and `resolveAccount` always use the primary, and never fall back.
 * The bank codes a customer chooses from and the code a transfer is sent with
 * must come from the same source — routing a name enquiry to a provider that
 * numbers banks differently would resolve the wrong institution and put a
 * plausible name in front of the customer. The fallback re-verifies with its own
 * codes at transfer time instead; see `PulseMfbPayoutProvider`.
 */
export class RoutedPayoutProvider implements PayoutProvider {
  /** The primary's name, so ledger rows read as the provider actually used. */
  readonly name: PayoutProviderName;

  constructor(
    private readonly primary: PayoutProvider,
    private readonly fallback: PayoutProvider,
    private readonly logger: PinoLogger,
  ) {
    this.name = primary.name;
    this.logger.setContext(RoutedPayoutProvider.name);
  }

  // ===========================================================================
  //  Reference data — primary only, by design
  // ===========================================================================

  listBanks(): Promise<Bank[]> {
    return this.primary.listBanks();
  }

  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    return this.primary.resolveAccount(accountNumber, bankCode);
  }

  // ===========================================================================
  //  Transfers
  // ===========================================================================

  async initiateTransfer(request: PayoutRequest): Promise<PayoutAcceptance> {
    try {
      return await this.primary.initiateTransfer(request);
    } catch (error) {
      if (!isSafeToReplace(error)) throw error;

      this.logger.warn(
        {
          reference: request.reference,
          primary: this.primary.name,
          fallback: this.fallback.name,
          reason: error instanceof AppException ? error.code : 'unknown',
        },
        'Primary payout provider refused; re-placing with the fallback',
      );

      try {
        const acceptance = await this.fallback.initiateTransfer(request);

        this.logger.info(
          { reference: request.reference, provider: this.fallback.name },
          'Payout accepted by the fallback provider',
        );

        return acceptance;
      } catch (fallbackError) {
        // Both refused. The primary's reason is the one that explains the
        // customer's situation — the fallback is an implementation detail they
        // have no model of — so it is what propagates, with the fallback's
        // attached for whoever reads the logs.
        this.logger.error(
          {
            reference: request.reference,
            fallback: this.fallback.name,
            fallbackReason:
              fallbackError instanceof AppException ? fallbackError.code : String(fallbackError),
          },
          'Fallback payout provider also refused',
        );
        throw error;
      }
    }
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /**
   * Not routed — and never called.
   *
   * Each provider posts to **its own** controller (`/falconpay/webhook`,
   * `/pulsemfb/webhook`), because each signs with its own secret and speaks its
   * own event vocabulary. Those controllers hold the concrete adapter. A router
   * that tried to verify a signature would have to guess which secret to use,
   * and "guess, then accept if either matches" is how a provider whose secret
   * leaked gets to forge the other one's events.
   */
  verifySignature(): boolean {
    throw new AppException(ErrorCode.INTERNAL_ERROR, {
      message: 'Payout webhooks must be verified by the provider that sent them',
      retryable: false,
    });
  }

  parseEvent(): NormalisedPayoutEvent {
    throw new AppException(ErrorCode.INTERNAL_ERROR, {
      message: 'Payout webhooks must be parsed by the provider that sent them',
      retryable: false,
    });
  }

  parseTransferResponse(
    raw: Record<string, unknown>,
    reference: string,
  ): NormalisedPayoutEvent | null {
    return this.primary.parseTransferResponse?.(raw, reference) ?? null;
  }

  fetchTransferStatus(reference: string): Promise<NormalisedPayoutEvent | null> {
    return this.primary.fetchTransferStatus?.(reference) ?? Promise.resolve(null);
  }
}

/**
 * Whether the primary's refusal proves nothing was queued.
 *
 * The default is **no**. An error this function does not recognise is treated as
 * "outcome unknown", because the cost of the two mistakes is wildly asymmetric:
 * failing to fall back delays one withdrawal, while falling back on an
 * in-flight transfer sends a stranger a second payment that cannot be recalled.
 */
function isSafeToReplace(error: unknown): boolean {
  if (!(error instanceof AppException)) return false;
  return REPLACEABLE_CODES.has(error.code);
}

/**
 * The only refusals that prove nothing was queued.
 *
 * - `PAYOUT_REJECTED` — they considered the instruction and refused it, so it
 *   never reached NIBSS.
 * - `SERVICE_UNAVAILABLE` — not configured, or their float is empty. Refused
 *   before the network was touched.
 * - `CIRCUIT_OPEN` — we never sent it at all.
 */
const REPLACEABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.PAYOUT_REJECTED,
  ErrorCode.SERVICE_UNAVAILABLE,
  ErrorCode.CIRCUIT_OPEN,
]);
