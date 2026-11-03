import { Inject, Injectable } from '@nestjs/common';
import { PayoutProviderName } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  type Bank,
  type NormalisedPayoutEvent,
  type PayoutAcceptance,
  PayoutEventStatus,
  type PayoutProvider,
  type PayoutRequest,
  type ResolvedAccount,
} from './payout-provider.interface';
import { PulseMfbClient, PulseMfbHttpError } from './pulsemfb.client';
import { PulseMfbProvider, type PulseWebhookPayload } from './pulsemfb.provider';

/** `POST /transfers/name-enquiry` → `data`. */
interface PulseNameEnquiryData {
  responseCode?: string;
  responseMessage?: string;
  accountName?: string;
  accountNumber?: string;
  bankCode?: string | null;
}

/** `POST /transfers` → `data`. */
interface PulseTransferData {
  reference?: string;
  internal_reference?: string;
  status?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** NIBSS's "successful" response code on a name enquiry. */
const NIP_SUCCESS = '00';

/** Kobo per naira. Pulse's API is denominated in naira. */
const KOBO_PER_NAIRA = 100n;

/**
 * Pulse MFB adapter — outward transfers.
 *
 * Configured as the *fallback* behind FalconPay rather than as a primary, and
 * the difference is economic rather than technical: transfers here debit a float
 * we hold with Pulse, so the capacity is whatever we have pre-funded. That suits
 * overflow, not steady-state volume. See {@link RoutedPayoutProvider} for the
 * failover rule.
 *
 * ## Two things this adapter refuses to do
 *
 * **It will not list banks.** Pulse publishes no bank-list endpoint, and there
 * is no honest way to synthesise one — see {@link listBanks}.
 *
 * **It will not trust a bank code it has not checked.** Pulse's own
 * documentation is internally inconsistent about bank code format: the
 * name-enquiry example uses a six-digit NIBSS institution code (`000013`) while
 * the transfer example uses a three-digit CBN code (`058`). A code that came
 * from a *different* provider's bank list may therefore mean a different bank
 * here, or no bank at all. So every transfer re-runs name enquiry through Pulse
 * first and requires the returned name to match — see {@link initiateTransfer}.
 * Sending money to a stranger because two providers number banks differently is
 * not a recoverable error; NIP transfers do not reverse.
 */
@Injectable()
export class PulseMfbPayoutProvider implements PayoutProvider {
  readonly name = PayoutProviderName.PULSEMFB;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: PulseMfbClient,
    /** Reused for webhook signature verification — one secret, one implementation. */
    private readonly accounts: PulseMfbProvider,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PulseMfbPayoutProvider.name);
  }

  // ===========================================================================
  //  Reference data
  // ===========================================================================

  /**
   * Not available from Pulse.
   *
   * They publish name enquiry and transfer, but no endpoint that enumerates
   * destination banks. Returning an empty list would present as "no banks
   * available" on the withdrawal screen; returning a hard-coded list would be
   * this file asserting a mapping between bank names and codes that it has no
   * source for, and that assertion decides where money goes.
   *
   * So it throws, and {@link RoutedPayoutProvider} serves the bank list from the
   * primary provider instead. That is also the correct behaviour for the routed
   * case: the codes a customer picks from must come from whoever is going to be
   * asked to resolve them first.
   */
  listBanks(): Promise<Bank[]> {
    throw new AppException(ErrorCode.NOT_IMPLEMENTED, {
      message: 'Pulse MFB does not publish a bank list',
      details: {
        providerMessage:
          'Configure Pulse MFB as PAYOUT_FALLBACK_PROVIDER only; the primary serves the bank list.',
      },
      retryable: false,
    });
  }

  /**
   * Name enquiry.
   *
   * Note the camelCase body — `accountNumber`/`bankCode` — which is Pulse's
   * spelling on this endpoint alone. Their transfer endpoint uses snake_case for
   * the same two values. That is their inconsistency, and it stops here.
   */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    let data: PulseNameEnquiryData;
    try {
      data = await this.client.post<PulseNameEnquiryData>('/transfers/name-enquiry', {
        accountNumber,
        bankCode,
      });
    } catch (error) {
      throw this.toException(error, 'resolve');
    }

    const accountName = str(data.accountName).trim();
    const responseCode = str(data.responseCode);

    // Both conditions matter. NIBSS answers a bad account with a non-`00` code
    // *and* an empty name, but a partially-degraded gateway has been known to
    // return one without the other.
    if (!accountName || (responseCode && responseCode !== NIP_SUCCESS)) {
      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
        message: 'That account number could not be resolved at the selected bank',
        details: {
          accountNumber: mask(accountNumber),
          bankCode,
          ...(responseCode ? { responseCode } : {}),
          ...(data.responseMessage ? { providerMessage: str(data.responseMessage) } : {}),
        },
      });
    }

    return {
      // Their name-enquiry response echoes an `accountNumber` that, in their own
      // published example, is the *enquiring* account rather than the one asked
      // about. The value we sent is authoritative.
      accountNumber,
      bankCode: str(data.bankCode) || bankCode,
      accountName,
    };
  }

  // ===========================================================================
  //  Transfers
  // ===========================================================================

  /**
   * Queues an outward transfer, after re-verifying the destination.
   *
   * The name enquiry is not redundant with the one the caller already did. The
   * caller resolved through whichever provider led — normally FalconPay — using
   * a bank code from *that* provider's list. This confirms the same code names
   * the same account here, and refuses when it does not.
   *
   * The comparison is on the resolved *name*, not on the code, because the name
   * is what both providers agree to describe: if FalconPay says `058` is Jane
   * Doe's GTBank account and Pulse says `058` is somebody else's, the codes
   * disagree about the bank and the transfer must not go.
   */
  async initiateTransfer(request: PayoutRequest): Promise<PayoutAcceptance> {
    const naira = this.toWholeNaira(request.amount);
    const debitAccount = this.config.pulsemfb.debitAccountNumber;

    if (!debitAccount) {
      // Boot validation prevents this in production. Here as a guard for a
      // misconfigured non-production deploy, where the failure would otherwise
      // be an opaque upstream rejection.
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'The fallback payout provider is not configured',
        details: { providerMessage: 'PULSEMFB_DEBIT_ACCOUNT_NUMBER is unset' },
        retryable: false,
      });
    }

    await this.assertDestinationAgrees(request);

    let data: PulseTransferData;
    try {
      data = await this.client.post<PulseTransferData>('/transfers', {
        debit_account_number: debitAccount,
        beneficiary_account_number: request.accountNumber,
        beneficiary_bank_code: request.bankCode,
        beneficiary_name: request.accountName,
        amount: naira,
        narration: request.narration,
        reference: request.reference,
      });
    } catch (error) {
      throw this.toException(error, 'transfer');
    }

    // Pulse answers `status: "completed"` synchronously on their happy path.
    // That is *not* treated as settlement: the return type is an acceptance, and
    // the payout stays open until a terminal webhook — or a lookup — confirms
    // it. A provider's optimistic inline status is not a NIBSS confirmation.
    return {
      providerReference: str(data.internal_reference) || undefined,
      sessionId: str(data.session_id) || undefined,
      raw: { ...data },
    };
  }

  /**
   * Refuses a transfer whose destination Pulse resolves differently.
   *
   * A failure to *reach* name enquiry is deliberately fatal rather than
   * ignorable. Skipping the check on a timeout would mean the one moment the
   * check is unavailable is the moment it is bypassed, which is precisely
   * backwards.
   */
  private async assertDestinationAgrees(request: PayoutRequest): Promise<void> {
    const resolved = await this.resolveAccount(request.accountNumber, request.bankCode);

    if (!namesMatch(resolved.accountName, request.accountName)) {
      this.logger.error(
        {
          reference: request.reference,
          bankCode: request.bankCode,
          accountNumber: mask(request.accountNumber),
        },
        'Fallback provider resolved a different account holder; refusing transfer',
      );

      throw new AppException(ErrorCode.PAYOUT_REJECTED, {
        message: 'The fallback provider could not confirm the destination account',
        details: {
          providerMessage:
            'Name enquiry through Pulse MFB returned a different account holder. ' +
            'The two providers most likely disagree on this bank code.',
        },
        retryable: false,
      });
    }
  }

  /**
   * Converts a kobo amount to the whole naira Pulse accepts.
   *
   * Identical reasoning to FalconPay's: truncating a fractional naira would
   * quietly short the customer by up to 99 kobo and leave the ledger disagreeing
   * with the bank, so a fractional amount is refused and the rounding bug stays
   * loud.
   */
  private toWholeNaira(amount: Money): number {
    if (!amount.isPositive()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Transfer amount must be greater than zero',
      });
    }

    if (amount.kobo % KOBO_PER_NAIRA !== 0n) {
      throw new AppException(ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED, {
        message: 'Transfers must be a whole number of naira',
        details: { amount: amount.toDecimalString() },
      });
    }

    return Number(amount.kobo / KOBO_PER_NAIRA);
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /** Delegated: one webhook secret, one verifier, shared with the account adapter. */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    return this.accounts.verifySignature(rawBody, signature);
  }

  /**
   * Normalises a `transfer.*` event that debits our float.
   *
   * The controller has already classified direction; anything reaching here is
   * one of our own outward transfers.
   */
  parseEvent(payload: unknown): NormalisedPayoutEvent {
    const event = (payload ?? {}) as PulseWebhookPayload;
    const rawEventType = str(event.event, 'unknown');
    const reference = str(event.data?.reference);

    if (!reference) {
      // Without our reference the event cannot be attributed to a payout, and
      // guessing from the amount is not a thing we will do with money.
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Payout webhook carried no reference',
        details: { rawEventType },
      });
    }

    return {
      reference,
      rawEventType,
      status: this.toEventStatus(rawEventType, str(event.data?.status).toLowerCase()),
      providerReference: str(event.data?.internal_reference) || undefined,
      sessionId: str(event.data?.session_id) || undefined,
      message: str(event.data?.narration) || undefined,
    };
  }

  /**
   * Maps their event vocabulary onto ours.
   *
   * The **event name is authoritative** and the body's `status` is only
   * consulted when the event name does not settle it. Pulse's event names are
   * explicit terminal statements (`transfer.completed`, `transfer.failed`) while
   * `data.status` has been observed carrying the value from acceptance time.
   *
   * An unrecognised combination is {@link PayoutEventStatus.Ignored}, never a
   * guess: inventing "failed" from something we do not understand releases a
   * hold on a transfer that may well have succeeded, and the customer then
   * spends money the bank has already sent.
   */
  private toEventStatus(rawEventType: string, status: string): PayoutEventStatus {
    if (rawEventType === 'transfer.completed') return PayoutEventStatus.Completed;
    if (rawEventType === 'transfer.failed') return PayoutEventStatus.Failed;

    switch (status) {
      case 'completed':
      case 'successful':
      case 'success':
        return PayoutEventStatus.Completed;
      case 'failed':
      case 'reversed':
      case 'cancelled':
        return PayoutEventStatus.Failed;
      case 'processing':
      case 'pending':
        return PayoutEventStatus.Processing;
      default:
        this.logger.warn({ rawEventType, status }, 'Unrecognised Pulse MFB payout event; ignoring');
        return PayoutEventStatus.Ignored;
    }
  }

  // ===========================================================================
  //  Errors
  // ===========================================================================

  /**
   * Translates a transport failure into our payout vocabulary.
   *
   * The distinctions a caller acts on: *already submitted* (leave it alone),
   * *refused* (safe to release the hold, and safe for the router to try nobody
   * else), *unknown* (do neither), and *try later*.
   */
  private toException(error: unknown, stage: 'resolve' | 'transfer'): AppException {
    if (error instanceof AppException) return error;

    if (!(error instanceof PulseMfbHttpError)) {
      return new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The payout provider could not be reached',
        cause: error,
        retryable: true,
      });
    }

    // A write with no answer. Never a failure — the transfer may be in flight.
    if (error.isUnknownOutcome && stage === 'transfer') {
      this.logger.error(
        { timedOut: error.timedOut },
        'Pulse MFB transfer failed without a response; outcome is unknown',
      );
      return new AppException(ErrorCode.PAYOUT_UNKNOWN_OUTCOME, {
        message: 'The transfer was submitted but its outcome could not be confirmed',
        cause: error,
        retryable: false,
      });
    }

    const details = { providerMessage: error.providerMessage };

    if (error.status === 409 || /duplicate|already exists/i.test(error.providerMessage)) {
      return new AppException(ErrorCode.PAYOUT_DUPLICATE_REFERENCE, {
        message: 'A transfer has already been submitted under this reference',
        details,
        retryable: false,
      });
    }

    if (error.status === 429) {
      return new AppException(ErrorCode.RATE_LIMIT_EXCEEDED, {
        message: 'The payout provider is rate limiting us; try again shortly',
        details,
        retryable: true,
      });
    }

    // Their insufficient-balance refusal arrives as a plain 400. It is worth
    // separating because it is the one 4xx here that says nothing about the
    // customer's request — our float is empty, and an operator needs to know
    // that rather than reading it as a rejected account number.
    if (error.status === 400 && /insufficient balance/i.test(error.providerMessage)) {
      this.logger.error(
        { providerMessage: error.providerMessage },
        'Pulse MFB float is exhausted; fallback payouts will keep failing until it is topped up',
      );
      return new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
        message: 'The fallback payout provider has insufficient float',
        details,
        retryable: true,
      });
    }

    if (error.isDefiniteRejection) {
      return new AppException(ErrorCode.PAYOUT_REJECTED, {
        message: 'The payout provider rejected this transfer',
        details,
        retryable: false,
      });
    }

    return new AppException(
      error.timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR,
      {
        message: 'The payout provider could not be reached',
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
 * Whether two bank-held names describe the same person.
 *
 * Compared on the *set* of alphanumeric tokens, because Nigerian banks are not
 * consistent about word order or punctuation: `OJO, DAYO` and `DAYO OJO` are the
 * same customer at two institutions, and a literal comparison would refuse a
 * perfectly good transfer. Middle names are frequently present at one bank and
 * absent at another, so one side's tokens being a subset of the other's counts
 * as agreement.
 *
 * The check exists to catch *different people*, not different spellings, and it
 * is tuned accordingly: strict enough that an unrelated name fails, loose enough
 * that formatting does not.
 */
export function namesMatch(a: string, b: string): boolean {
  const tokensOf = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 1),
    );

  const left = tokensOf(a);
  const right = tokensOf(b);

  if (left.size === 0 || right.size === 0) return false;

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of smaller) {
    if (!larger.has(token)) return false;
  }
  return true;
}

/** Coerces an untrusted provider field to a string. See the note in the account adapter. */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

/** Last four digits only — enough to identify, not enough to leak in a log. */
function mask(accountNumber: string): string {
  return accountNumber.length <= 4 ? '****' : `******${accountNumber.slice(-4)}`;
}
