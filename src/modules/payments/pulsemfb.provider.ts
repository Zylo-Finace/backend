import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { BankAccountProvider } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import {
  type NormalisedWebhookEvent,
  type PaymentProvider,
  type VirtualAccount,
  type VirtualAccountRequest,
  WebhookEventKind,
} from './payment-provider.interface';
import { PulseMfbClient, PulseMfbHttpError } from './pulsemfb.client';

/** Their signature header. */
export const PULSEMFB_SIGNATURE_HEADER = 'x-webhook-signature';
/** Their event-name header. Mirrors `event` in the body; the body wins. */
export const PULSEMFB_EVENT_HEADER = 'x-event-type';

/** `POST /accounts/prefix` → `data`. */
interface PulseAccountData {
  account_number?: string;
  account_name?: string;
  reference?: string;
  created_at?: string;
}

/** The shape shared by every Pulse webhook. */
export interface PulseWebhookPayload {
  event?: string;
  timestamp?: string;
  data?: {
    reference?: string;
    amount?: number | string;
    debit_account?: string;
    credit_account?: string;
    account_number?: string;
    account_name?: string;
    status?: string;
    narration?: string;
    [key: string]: unknown;
  };
}

/**
 * What a `transfer.*` event is actually telling us.
 *
 * Pulse publishes one transfer event for both directions — the payload names a
 * debit account and a credit account and nothing else — so the direction has to
 * be inferred. See {@link classifyTransferEvent}.
 */
export enum PulseTransferDirection {
  /** Money leaving our float: one of our payouts. */
  Outbound = 'outbound',
  /** Money arriving in an account we issued: a customer funding their wallet. */
  Inbound = 'inbound',
  /** Neither account is ours. Not actionable. */
  Unrelated = 'unrelated',
}

/**
 * Works out which way a `transfer.*` event was moving money.
 *
 * The rule is deliberately based on the **debit** side. Our float is a single,
 * configured account number (`PULSEMFB_DEBIT_ACCOUNT_NUMBER`); every payout we
 * initiate debits it, and nothing else does. So a transfer that debits it is
 * ours going out, and a transfer that credits an account we issued while
 * debiting something else is a customer paying in.
 *
 * Keying on the debit side rather than on the reference matters because
 * references are not reliably distinguishable: an inbound transfer carries the
 * *sender's bank's* reference, which we have never seen and which could in
 * principle collide with the format we generate.
 *
 * Anything that is neither is `Unrelated` rather than a guess. On this path a
 * wrong guess either credits a wallet with money that never arrived, or settles
 * a payout that never happened.
 */
export function classifyTransferEvent(
  payload: PulseWebhookPayload,
  ourFloatAccountNumber: string,
): PulseTransferDirection {
  const debit = str(payload.data?.debit_account);
  const credit = str(payload.data?.credit_account);

  if (ourFloatAccountNumber && debit === ourFloatAccountNumber) {
    return PulseTransferDirection.Outbound;
  }

  // A credited NUBAN that is not our float is a customer account — the funding
  // service resolves *which* customer, and rejects one it does not recognise.
  if (credit && credit !== ourFloatAccountNumber) {
    return PulseTransferDirection.Inbound;
  }

  return PulseTransferDirection.Unrelated;
}

/**
 * Pulse MFB adapter — issues dedicated NUBANs and normalises inbound credits.
 *
 * ## What makes this provider different from the others
 *
 * Paystack and PayVessel broker accounts at *partner* banks: the NUBAN belongs
 * to Wema or Providus, and money paid into it settles to us later. Pulse is
 * itself the bank. Every account issued here is a **sub-account of our own**,
 * carrying our business prefix (`CAL'/'Dayo Ojo`), and money paid into one lands
 * directly in our balance with Pulse.
 *
 * Two consequences shape the code below.
 *
 * **The bank identity comes from config, not from the response.** Their
 * create-account response names no bank, because from their side the answer is
 * always "us". A customer still has to be told where to send money, so
 * `PULSEMFB_BANK_CODE` and `PULSEMFB_BANK_NAME` supply it.
 *
 * **The account name is not the customer's name.** It is the prefixed form, and
 * it is what the sender's bank will display on a name enquiry. It is stored
 * verbatim rather than cleaned up, because a customer comparing what their app
 * shows against what their bank shows must see the same string.
 *
 * ## The gap worth knowing about
 *
 * Pulse's documented event list — `account.created`, `transfer.completed`,
 * `transfer.failed`, `vas.completed`, `vas.failed` — contains **no dedicated
 * inbound-credit event**. Inbound funding is therefore read off
 * `transfer.completed`, classified by {@link classifyTransferEvent}. If Pulse
 * does not in fact emit that event for third-party credits into a sub-account,
 * wallet funding through this provider will not work, and no amount of care in
 * this file changes that. It is verifiable in one test transfer against the
 * sandbox, and it should be verified before this provider carries live traffic.
 */
@Injectable()
export class PulseMfbProvider implements PaymentProvider {
  readonly name = BankAccountProvider.PULSEMFB;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: PulseMfbClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PulseMfbProvider.name);
  }

  // ===========================================================================
  //  Account issuance
  // ===========================================================================

  /**
   * Issues a dedicated NUBAN for a customer.
   *
   * `request.userId` is *not* sent: Pulse echoes only `reference` back, and that
   * is what the account is matched on afterwards. The reference is derived from
   * the user id so that a redelivered `account.created` — or a retry after a
   * timeout — resolves to the same customer rather than to a second account.
   */
  async createVirtualAccount(request: VirtualAccountRequest): Promise<VirtualAccount> {
    const reference = accountReference(request.userId);

    let data: PulseAccountData;
    try {
      data = await this.client.post<PulseAccountData>('/accounts/prefix', {
        customer_name: request.fullName,
        customer_phone: toLocalMsisdn(request.phoneE164),
        customer_email: request.email,
        // Sent when we hold one. Pulse's own example omits it — these are
        // sub-accounts of an already-KYC'd business account — but supplying a
        // verified BVN is what lets them raise the sub-account's limits, and
        // withholding one we have would cap the customer for no reason.
        ...(request.bvn ? { bvn: request.bvn } : {}),
        ...(request.nin ? { nin: request.nin } : {}),
        reference,
      });
    } catch (error) {
      throw this.toAccountException(error);
    }

    const accountNumber = str(data.account_number);
    if (!/^\d{10}$/.test(accountNumber)) {
      // A malformed NUBAN would be shown to a customer as somewhere to send
      // money. Better to have no account than a wrong one.
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The account provider returned an unusable account number',
        details: { reference },
        retryable: true,
      });
    }

    return {
      provider: this.name,
      reference: str(data.reference, reference),
      bankName: this.config.pulsemfb.bankName,
      bankCode: this.config.pulsemfb.bankCode,
      // Stored exactly as Pulse gives it, prefix and all — it is what the
      // sender's bank shows on a name enquiry, and the two must agree.
      accountName: str(data.account_name, request.fullName),
      accountNumber,
      currency: 'NGN',
      raw: { ...data },
    };
  }

  /**
   * Translates a provisioning failure.
   *
   * The distinction that matters to `AccountProvisioningService` is whether
   * trying again could ever work. A refusal (4xx) will be refused identically
   * next time; a timeout or a 5xx will not, and account provisioning is retried
   * out of band precisely so those recover on their own.
   */
  private toAccountException(error: unknown): AppException {
    if (!(error instanceof PulseMfbHttpError)) {
      return new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The account provider could not be reached',
        cause: error,
        retryable: true,
      });
    }

    const details = { providerMessage: error.providerMessage };

    if (error.status === 409) {
      return new AppException(ErrorCode.RESOURCE_ALREADY_EXISTS, {
        message: 'An account has already been issued under this reference',
        details,
        retryable: false,
      });
    }

    return new AppException(
      error.timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR,
      {
        message: 'The account provider could not issue an account',
        details,
        cause: error,
        retryable: !error.isDefiniteRejection,
      },
    );
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /**
   * Verifies `X-Webhook-Signature`: HMAC-SHA256 of the raw body, keyed with the
   * webhook secret — *not* the API private key, which signs outbound requests.
   *
   * Pulse's published example verifies against `JSON.stringify(req.body)`, which
   * is a re-serialisation of an already-parsed object. That is only ever correct
   * by luck: it depends on their serialiser and ours agreeing on key order and
   * whitespace. This verifies the bytes as received, which is correct by
   * construction — and is why `rawBody: true` is set in `main.ts`.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;

    const secret = this.config.pulsemfb.webhookSecret;
    if (!secret) {
      // Fail closed. An unconfigured secret must never mean "accept everything"
      // — an accepted forgery here credits a wallet with money that never came.
      this.logger.error('Pulse MFB webhook secret is not configured; rejecting webhook');
      return false;
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = signature.trim().toLowerCase();

    // Length is compared first because `timingSafeEqual` throws on a mismatch.
    // Constant-time thereafter: a byte-by-byte `===` leaks how much of the
    // digest matched, which is enough to forge one given enough attempts.
    if (expected.length !== provided.length) return false;

    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  }

  /**
   * Normalises the events that concern the *inbound* leg.
   *
   * `transfer.*` events that debit our float belong to the payout adapter, not
   * here; the controller classifies before dispatching, so anything reaching
   * this method is either an account assignment or a credit.
   */
  parseEvent(payload: unknown): NormalisedWebhookEvent {
    const event = (payload ?? {}) as PulseWebhookPayload;
    const rawEventType = str(event.event, 'unknown');

    switch (rawEventType) {
      case 'account.created':
        return this.parseAccountCreated(event, rawEventType);

      case 'transfer.completed':
        return this.parseInboundCredit(event, rawEventType);

      // A failed transfer on the inbound leg is a payment that never arrived.
      // There is nothing to reverse — we never credited anything — so it is
      // recorded and dropped.
      case 'transfer.failed':
      case 'vas.completed':
      case 'vas.failed':
      case 'webhook.test':
        return { rawEventType, kind: WebhookEventKind.Ignored };

      default:
        this.logger.warn({ rawEventType }, 'Unrecognised Pulse MFB event; ignoring');
        return { rawEventType, kind: WebhookEventKind.Ignored };
    }
  }

  /** `account.created` — a sub-account finished provisioning. */
  private parseAccountCreated(
    event: PulseWebhookPayload,
    rawEventType: string,
  ): NormalisedWebhookEvent {
    const accountNumber = str(event.data?.account_number);
    const reference = str(event.data?.reference);

    if (!/^\d{10}$/.test(accountNumber)) {
      return { rawEventType, kind: WebhookEventKind.AccountAssignmentFailed };
    }

    return {
      providerEventId: reference || undefined,
      rawEventType,
      kind: WebhookEventKind.AccountAssigned,
      accountAssignment: {
        // Recovered from our own reference rather than trusted from the payload:
        // Pulse echoes back what we sent, and what we sent encodes the user id.
        userId: userIdFromAccountReference(reference),
        account: {
          provider: this.name,
          reference: reference || accountNumber,
          bankName: this.config.pulsemfb.bankName,
          bankCode: this.config.pulsemfb.bankCode,
          accountName: str(event.data?.account_name),
          accountNumber,
          currency: 'NGN',
          raw: { ...event.data },
        },
      },
    };
  }

  /** `transfer.completed`, already classified as money arriving. */
  private parseInboundCredit(
    event: PulseWebhookPayload,
    rawEventType: string,
  ): NormalisedWebhookEvent {
    const reference = str(event.data?.reference);
    const destination = str(event.data?.credit_account);
    const amount = parseNairaAmount(event.data?.amount);

    if (!reference || !destination || !amount?.isPositive()) {
      // Every one of these is load-bearing: the reference is the ledger's
      // idempotency key, the account decides whose wallet is credited, and the
      // amount is how much. A payload missing any of them cannot be applied, and
      // guessing is not an option when the subject is money.
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Funding webhook was missing a reference, destination or amount',
        details: { rawEventType, hasReference: Boolean(reference) },
      });
    }

    return {
      providerEventId: reference,
      rawEventType,
      kind: WebhookEventKind.FundingReceived,
      transfer: {
        reference,
        amount,
        destinationAccountNumber: destination,
        // Pulse names no sender on this payload. The narration is the only trace
        // of where the money came from, and it is what the statement will show.
        senderName: str(event.data?.narration) || undefined,
        paidAt: parseDate(event.timestamp),
      },
    };
  }
}

// =============================================================================
//  Helpers
// =============================================================================

/** Prefix marking a reference as one of ours, and the user id it encodes. */
const ACCOUNT_REFERENCE_PREFIX = 'ACC-';

/**
 * The reference sent when issuing an account.
 *
 * Derived from the user id rather than random so that it is *stable*: a retry
 * after a timeout sends the same reference, and Pulse's duplicate handling turns
 * what would have been a second account into a rejection we can recognise.
 */
export function accountReference(userId: string): string {
  return `${ACCOUNT_REFERENCE_PREFIX}${userId}`;
}

/** Inverse of {@link accountReference}. Returns undefined for anything else. */
export function userIdFromAccountReference(reference: string): string | undefined {
  if (!reference.startsWith(ACCOUNT_REFERENCE_PREFIX)) return undefined;
  const userId = reference.slice(ACCOUNT_REFERENCE_PREFIX.length);
  return userId || undefined;
}

/**
 * Converts E.164 to the local `0803…` form Pulse expects.
 *
 * Their examples are uniformly local-format. Sending `+234…` where a provider
 * expects `0…` is usually a validation error, but is occasionally worse — a
 * silently truncated number that delivers to somebody else.
 */
export function toLocalMsisdn(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length >= 13) return `0${digits.slice(3)}`;
  if (digits.startsWith('0')) return digits;
  return digits.length === 10 ? `0${digits}` : digits;
}

/**
 * Parses a naira amount into {@link Money}.
 *
 * Pulse denominates in **naira**, sometimes with decimals (`50000.00`) and
 * sometimes as a bare integer (`5000`). It arrives here as a JSON number, which
 * is a float — so it is stringified and parsed as decimal rather than multiplied
 * by 100, because `5000.07 * 100` is `500006.9999…` and truncating that loses a
 * kobo on a path where the ledger has to balance exactly.
 */
export function parseNairaAmount(value: unknown): Money | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;

  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;

  try {
    return Money.fromNaira(text);
  } catch {
    return undefined;
  }
}

/** An ISO timestamp, or undefined when it is absent or unparseable. */
function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Coerces an untrusted provider field to a string.
 *
 * `String(value)` on a nested object yields `"[object Object]"`, which would
 * happily be stored as somebody's account number. Anything that is not already a
 * primitive becomes the fallback instead, so a malformed payload produces an
 * obviously-empty field rather than plausible-looking garbage.
 */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}
