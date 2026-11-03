import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PayoutProviderName } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import {
  type Bank,
  type NormalisedPayoutEvent,
  type PayoutAcceptance,
  PayoutEventStatus,
  type PayoutProvider,
  type PayoutRequest,
  type ResolvedAccount,
} from './payout-provider.interface';
import { cleanBankDisplayName } from './bank-display-name';

/** FalconPay envelope: every response is `{ success, message, data }`. */
interface FalconPayEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
  /** Machine-readable code on failures: `DUPLICATE_REFERENCE`, `RATE_LIMITED`, … */
  error?: string;
}

interface FalconPayTransferData {
  transaction_reference?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** The status webhook body, as documented. */
interface FalconPayWebhookPayload {
  reference?: string;
  transaction_reference?: string;
  success?: boolean;
  status?: string;
  session_id?: string;
  message?: string;
}

/** Their signature header. */
export const FALCONPAY_SIGNATURE_HEADER = 'x-falconpay-signature';

/** The timestamp that is signed together with the body: `{timestamp}.{rawBody}`. */
export const FALCONPAY_TIMESTAMP_HEADER = 'x-falconpay-timestamp';

/** Kobo per naira. FalconPay's API is denominated in whole naira. */
const KOBO_PER_NAIRA = 100n;

/**
 * FalconPay adapter — outward transfers to Nigerian bank accounts.
 *
 * Everything provider-specific is confined here: the `{success, message, data}`
 * envelope, the `x-api-key` credential, the `DUPLICATE_REFERENCE` vocabulary,
 * HMAC-SHA256 webhook signatures, and — most importantly — the fact that their
 * amounts are **whole naira** while every balance in this system is kobo.
 *
 * ## The two things this class exists to get right
 *
 * **1. A 202 is not a success.** `initiateTransfer` resolving means FalconPay
 * queued the instruction, nothing more. The outcome arrives on a webhook,
 * possibly minutes later, possibly as a failure. The return type is named
 * {@link PayoutAcceptance} rather than `PayoutResult` so that a caller who
 * treats it as confirmation has to do so deliberately.
 *
 * **2. Unknown is not failed.** If the request times out, the transfer may have
 * been accepted anyway — the response was lost, not the instruction. Treating
 * that as a failure and releasing the customer's hold is how the same money gets
 * spent twice. Timeouts therefore raise {@link ErrorCode.PAYOUT_UNKNOWN_OUTCOME}
 * and are deliberately *not* retryable.
 */
@Injectable()
export class FalconPayProvider implements PayoutProvider {
  readonly name = PayoutProviderName.FALCONPAY;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(FalconPayProvider.name);
  }

  // ===========================================================================
  //  Reference data
  // ===========================================================================

  /**
   * The supported bank list.
   *
   * Rate-limited to 60/min upstream and effectively static, so callers cache it.
   * Deliberately no caching here: the adapter's job is the wire format.
   */
  async listBanks(): Promise<Bank[]> {
    const data = await this.call<unknown>('GET', '/api/banks');

    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as { banks?: unknown })?.banks)
        ? (data as { banks: unknown[] }).banks
        : null;

    if (!rows) {
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The payout provider returned an unexpected bank list',
        retryable: true,
      });
    }

    return (
      rows
        .map((entry) => {
          const bank = (entry ?? {}) as Record<string, unknown>;
          return {
            name: cleanBankDisplayName(str(bank.name)),
            code: str(bank.code),
          };
        })
        // A bank with no code cannot be selected and would only ever produce a
        // failed transfer, so it is dropped rather than shown to a customer.
        .filter((bank) => bank.code !== '' && bank.name !== '')
    );
  }

  /**
   * Name enquiry.
   *
   * The returned name is what gets sent on the transfer. NIP transfers are not
   * reversible, so "the customer typed it" is never an acceptable provenance for
   * a recipient name.
   */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    const query = new URLSearchParams({
      account_number: accountNumber,
      bank_code: bankCode,
    });

    const data = await this.call<Record<string, unknown>>(
      'GET',
      `/api/verify-bank?${query.toString()}`,
    );

    // Their documented field is `account_name`; the camelCase spelling is
    // accepted too because a provider changing case on a rename should degrade
    // to a clear error, not to an account named "".
    const accountName = str(data?.account_name ?? data?.accountName);

    if (!accountName) {
      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
        message: 'That account number could not be resolved at the selected bank',
        details: { accountNumber: mask(accountNumber), bankCode },
      });
    }

    return {
      accountNumber: str(data?.account_number ?? data?.accountNumber, accountNumber),
      bankCode: str(data?.bank_code ?? data?.bankCode, bankCode),
      accountName,
    };
  }

  // ===========================================================================
  //  Transfers
  // ===========================================================================

  /**
   * Queues an outward transfer.
   *
   * `reference` is our idempotency key: FalconPay rejects a second use of it with
   * 409, which is surfaced as {@link ErrorCode.PAYOUT_DUPLICATE_REFERENCE} so the
   * caller can recognise "already submitted" and leave the hold in place instead
   * of unwinding a transfer that is genuinely in flight.
   */
  async initiateTransfer(request: PayoutRequest): Promise<PayoutAcceptance> {
    const naira = this.toWholeNaira(request.amount);

    const { data, envelope } = await this.callParsed<FalconPayTransferData>(
      'POST',
      '/api/transfer',
      {
        reference: request.reference,
        amount: naira,
        bank_code: request.bankCode,
        account_number: request.accountNumber,
        account_name: request.accountName,
        sender_name: this.config.payouts.falconpay.senderName,
        narration: request.narration,
      },
    );

    const raw = this.mergeTransferRaw(request.reference, data, envelope);

    return {
      providerReference: data?.transaction_reference ? str(data.transaction_reference) : undefined,
      sessionId: data?.session_id ? str(data.session_id) : undefined,
      raw,
    };
  }

  /**
   * Converts a kobo amount to the whole naira FalconPay accepts.
   *
   * The API takes an integer naira amount, which means sub-naira precision
   * cannot be expressed. Truncating would quietly short the customer by up to
   * 99 kobo per withdrawal and leave the ledger disagreeing with the bank, so a
   * fractional amount is refused instead. Callers are expected to offer whole
   * naira in the UI; this is the backstop that makes a rounding bug loud.
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

    // Safe as a Number: the configured ceiling is far below 2^53, and the
    // division has no remainder by the check above.
    return Number(amount.kobo / KOBO_PER_NAIRA);
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /**
   * Verifies `x-falconpay-signature`: HMAC-SHA256 of `{timestamp}.{rawBody}`,
   * keyed with the **webhook** secret (`whsec_…`), not the API key. The
   * timestamp arrives in `x-falconpay-timestamp`.
   *
   * A signature over the body alone is still accepted. FalconPay's own reference
   * shows both forms, and either one requires the secret — so accepting the
   * older form costs nothing in authenticity and avoids dropping every webhook
   * the day their signer and their docs disagree.
   *
   * Constant-time comparison — a byte-by-byte `===` leaks how much of the digest
   * matched, which is enough to forge a signature given enough attempts.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined, timestamp?: string): boolean {
    if (!signature) return false;

    const secret = this.config.payouts.falconpay.webhookSecret;
    if (!secret) {
      // Fail closed. An unconfigured secret must never mean "accept everything"
      // — on this path an accepted forgery settles a payout that never happened.
      this.logger.error('FalconPay webhook secret is not configured; rejecting webhook');
      return false;
    }

    const provided = signature.trim().toLowerCase();
    const ts = timestamp?.trim();

    const candidates = [
      ...(ts ? [createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex')] : []),
      createHmac('sha256', secret).update(rawBody).digest('hex'),
    ];

    return candidates.some(
      (expected) =>
        expected.length === provided.length &&
        timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8')),
    );
  }

  /**
   * Normalises a status webhook.
   *
   * The payload has no event-type field — the `status` *is* the event — so
   * `rawEventType` is synthesised from it to keep the stored audit record
   * readable alongside other providers'.
   */
  parseEvent(payload: unknown): NormalisedPayoutEvent {
    const event = this.unwrapWebhookPayload(payload);
    const reference = str(event.reference);
    if (!reference) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Payout webhook carried no reference',
      });
    }
    return this.eventFromTransferRecord(reference, event as Record<string, unknown>);
  }

  parseTransferResponse(
    raw: Record<string, unknown>,
    reference: string,
  ): NormalisedPayoutEvent | null {
    const event = this.eventFromTransferRecord(reference, raw);
    return event.status === PayoutEventStatus.Processing ||
      event.status === PayoutEventStatus.Ignored
      ? null
      : event;
  }

  async fetchTransferStatus(reference: string): Promise<NormalisedPayoutEvent | null> {
    const paths = [
      `/api/transfer?reference=${encodeURIComponent(reference)}`,
      `/api/transfer/${encodeURIComponent(reference)}`,
      `/api/transfers/${encodeURIComponent(reference)}`,
    ];

    for (const path of paths) {
      try {
        const { data, envelope } = await this.callParsed<Record<string, unknown>>('GET', path);
        const event = this.eventFromTransferRecord(
          reference,
          this.mergeTransferRaw(reference, data, envelope),
        );
        if (
          event.status !== PayoutEventStatus.Processing &&
          event.status !== PayoutEventStatus.Ignored
        ) {
          return event;
        }
      } catch (error) {
        const code = error instanceof AppException ? error.code : undefined;
        if (code === ErrorCode.RESOURCE_NOT_FOUND || code === ErrorCode.ROUTE_NOT_FOUND) {
          continue;
        }
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error), reference, path },
          'FalconPay transfer status poll failed',
        );
      }
    }

    return null;
  }

  private mergeTransferRaw(
    reference: string,
    data: FalconPayTransferData | Record<string, unknown> | undefined,
    envelope: FalconPayEnvelope<unknown> | null,
  ): Record<string, unknown> {
    const record: Record<string, unknown> = {
      ...(data ?? {}),
      reference,
    };

    if (envelope) {
      record.success = envelope.success;
      if (envelope.message) record.message = envelope.message;
    }

    const status = str(record.status).toLowerCase();
    if (!status && envelope?.success === true && record.transaction_reference) {
      // Live FalconPay often confirms wallet transfers synchronously in the
      // envelope only — no status on `data`, and no webhook afterwards.
      record.status = 'completed';
    }

    return record;
  }

  private unwrapWebhookPayload(payload: unknown): FalconPayWebhookPayload {
    const root = (payload ?? {}) as Record<string, unknown>;
    const nested = root.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested;
    }
    return root;
  }

  private eventFromTransferRecord(
    reference: string,
    payload: Record<string, unknown>,
  ): NormalisedPayoutEvent {
    const raw = str(payload.status).toLowerCase();
    return {
      reference: str(payload.reference, reference),
      rawEventType: `payout.${raw || 'unknown'}`,
      status: this.toEventStatus(raw, payload.success as boolean | undefined),
      providerReference: payload.transaction_reference
        ? str(payload.transaction_reference)
        : undefined,
      sessionId: payload.session_id ? str(payload.session_id) : undefined,
      message: payload.message ? str(payload.message) : undefined,
    };
  }

  /**
   * Maps their status vocabulary onto ours.
   *
   * `status` is authoritative and `success` is only a tiebreaker for a missing
   * status: a payload that says `completed` is completed regardless of the
   * boolean. An unrecognised status is {@link PayoutEventStatus.Ignored} rather
   * than a guess — inventing "failed" from a status we do not understand would
   * release a hold on a transfer that may well have succeeded.
   */
  private toEventStatus(status: string, success: boolean | undefined): PayoutEventStatus {
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

      case '':
        // No status at all: fall back to the boolean, which is the only signal
        // left. Still never guesses — `undefined` stays ignored.
        if (success === true) return PayoutEventStatus.Completed;
        if (success === false) return PayoutEventStatus.Failed;
        return PayoutEventStatus.Ignored;

      default:
        this.logger.warn({ status }, 'Unrecognised payout status from FalconPay; ignoring');
        return PayoutEventStatus.Ignored;
    }
  }

  // ===========================================================================
  //  HTTP
  // ===========================================================================

  /**
   * One outbound call to FalconPay.
   *
   * Uses `fetch` with an `AbortSignal` timeout: an outbound call with no deadline
   * will eventually hold a request (or a queue worker) open indefinitely when the
   * provider degrades, and that is how one slow dependency saturates a service.
   */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const parsed = await this.callParsed<T>(method, path, body);
    return parsed.data;
  }

  private async callParsed<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ data: T; envelope: FalconPayEnvelope<T> | null }> {
    const url = `${this.config.payouts.falconpay.baseUrl}${path}`;
    const started = Date.now();
    // The query string is stripped so name enquiries do not each produce a
    // distinct metric label — an unbounded label set is how a metrics backend
    // falls over.
    const operation = `falconpay${path.split('?')[0]!.replace(/\//g, '_')}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'x-api-key': this.config.payouts.falconpay.secretKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.payments.httpTimeoutMs),
      });
    } catch (cause) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'error' });

      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';

      // A transfer that we could not get an answer about is the dangerous case:
      // the instruction may well have been queued. Reads are safely retryable;
      // a write is not, and is escalated instead.
      if (method === 'POST') {
        this.logger.error(
          { path, timedOut, err: cause },
          'Transfer request failed without a response; outcome is unknown',
        );
        throw new AppException(ErrorCode.PAYOUT_UNKNOWN_OUTCOME, {
          message: 'The transfer was submitted but its outcome could not be confirmed',
          cause,
          retryable: false,
        });
      }

      throw new AppException(timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR, {
        message: 'The payout provider could not be reached',
        cause,
        retryable: true,
      });
    } finally {
      this.metrics.whatsappApiDuration.observe({ operation }, (Date.now() - started) / 1000);
    }

    const payload = (await response.json().catch(() => null)) as FalconPayEnvelope<T> | T | null;

    // Live FalconPay sometimes returns a bare JSON array/object (e.g. GET /api/banks)
    // instead of `{ success: true, data }`. Treat HTTP 2xx + usable body as success.
    const enveloped =
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'success' in (payload as object);

    if (enveloped) {
      const env = payload as FalconPayEnvelope<T>;
      if (!response.ok || env.success !== true) {
        this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });
        this.logger.error(
          {
            status: response.status,
            path: path.split('?')[0],
            providerMessage: env.message,
            providerError: env.error,
          },
          'FalconPay request failed',
        );
        throw this.toException(response, env);
      }
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'success' });
      return { data: env.data as T, envelope: env };
    }

    if (!response.ok || payload === null) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });
      this.logger.error(
        {
          status: response.status,
          path: path.split('?')[0],
          bare: true,
        },
        'FalconPay request failed',
      );
      throw this.toException(response, null);
    }

    this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'success' });
    // Bare array/object body — e.g. banks list returns `[{ name, code }, …]`
    return { data: payload as T, envelope: null };
  }

  /**
   * Translates a FalconPay error into ours.
   *
   * The distinctions that matter to a caller are: *this transfer already
   * exists* (409 — leave it alone), *they refused it* (422 — safe to release the
   * hold), and *try again later* (429/5xx). Everything else is a generic
   * upstream error.
   */
  private toException(
    response: Response,
    payload: FalconPayEnvelope<unknown> | null,
  ): AppException {
    // The provider's message is safe to surface: it explains *why* (unverified
    // business, invalid bank) and is what support will need. It carries no
    // secret — the credential lives only in the x-api-key header.
    const details = {
      providerMessage: payload?.message ?? `HTTP ${response.status}`,
      ...(payload?.error ? { providerError: payload.error } : {}),
    };

    if (response.status === 409 || payload?.error === 'DUPLICATE_REFERENCE') {
      return new AppException(ErrorCode.PAYOUT_DUPLICATE_REFERENCE, {
        message: 'A transfer has already been submitted under this reference',
        details,
        retryable: false,
      });
    }

    if (response.status === 422) {
      return new AppException(ErrorCode.PAYOUT_REJECTED, {
        message: 'The payout provider rejected this transfer',
        details,
        retryable: false,
      });
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      return new AppException(ErrorCode.RATE_LIMIT_EXCEEDED, {
        message: 'The payout provider is rate limiting us; try again shortly',
        details: { ...details, ...(retryAfter ? { retryAfter } : {}) },
        retryable: true,
      });
    }

    return new AppException(ErrorCode.UPSTREAM_ERROR, {
      message: 'The payout provider rejected the request',
      details,
      // 4xx is our mistake and will fail identically on retry; 5xx may not.
      retryable: response.status >= 500,
    });
  }
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

/** Last four digits only — enough to identify, not enough to leak in a log. */
function mask(accountNumber: string): string {
  return accountNumber.length <= 4 ? '****' : `******${accountNumber.slice(-4)}`;
}
