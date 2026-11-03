import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { BankAccountProvider } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import {
  type NormalisedWebhookEvent,
  type PaymentProvider,
  type VirtualAccount,
  type VirtualAccountRequest,
  WebhookEventKind,
} from './payment-provider.interface';

/** Paystack envelope: every response is `{ status, message, data }`. */
interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackCustomer {
  id: number;
  customer_code: string;
}

interface PaystackDedicatedAccount {
  id: number;
  account_name: string;
  account_number: string;
  currency: string;
  bank: { name: string; id: number; slug: string };
}

interface PaystackWebhookPayload {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Paystack adapter.
 *
 * Chosen as the default because it is the most widely deployed dedicated-NUBAN
 * provider in Nigeria. Everything provider-specific — the `{status, message,
 * data}` envelope, kobo amounts, HMAC-SHA512 signatures, the `charge.success`
 * event vocabulary — is confined to this file.
 */
@Injectable()
export class PaystackProvider implements PaymentProvider {
  readonly name = BankAccountProvider.PAYSTACK;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(PaystackProvider.name);
  }

  // ===========================================================================
  //  Provisioning
  // ===========================================================================

  /**
   * Creates a Paystack customer, then assigns them a dedicated NUBAN.
   *
   * Two calls, because Paystack models the account as belonging to a customer
   * record. The first is naturally idempotent — creating a customer with an
   * existing email returns the existing record rather than failing.
   */
  async createVirtualAccount(request: VirtualAccountRequest): Promise<VirtualAccount> {
    const customer = await this.call<PaystackCustomer>('POST', '/customer', {
      email: request.email,
      phone: request.phoneE164,
      // Paystack wants the name split; the customer gave us one string, so the
      // first token is the best available guess. The authoritative name on the
      // account is the one the bank returns, not this.
      first_name: request.fullName.split(' ')[0] ?? request.fullName,
      last_name: request.fullName.split(' ').slice(1).join(' ') || request.fullName,
      // Echoed back on webhooks, which is how an account-assignment event is
      // attributed to a user without a second lookup.
      metadata: { userId: request.userId },
    });

    const account = await this.call<PaystackDedicatedAccount>('POST', '/dedicated_account', {
      customer: customer.customer_code,
      preferred_bank: this.config.payments.paystack.preferredBank,
    });

    return {
      provider: BankAccountProvider.PAYSTACK,
      // The dedicated-account id is what inbound-transfer events reference.
      reference: String(account.id),
      bankName: account.bank.name,
      bankCode: account.bank.slug,
      accountName: account.account_name,
      accountNumber: account.account_number,
      currency: account.currency || 'NGN',
      raw: account as unknown as Record<string, unknown>,
    };
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /**
   * Verifies `x-paystack-signature`: HMAC-SHA512 of the raw body, keyed with the
   * secret key.
   *
   * Constant-time comparison — a byte-by-byte `===` leaks how much of the digest
   * matched, which is enough to forge a signature given enough attempts.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;

    const secret = this.config.payments.paystack.secretKey;
    if (!secret) {
      // Fail closed. An unconfigured secret must never mean "accept everything".
      this.logger.error('Paystack secret key is not configured; rejecting webhook');
      return false;
    }

    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const provided = signature.trim().toLowerCase();

    if (expected.length !== provided.length) return false;

    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  }

  parseEvent(payload: unknown): NormalisedWebhookEvent {
    const event = payload as PaystackWebhookPayload;

    if (typeof event?.event !== 'string' || typeof event.data !== 'object' || !event.data) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Unrecognised webhook payload',
      });
    }

    switch (event.event) {
      case 'charge.success':
        return this.parseCharge(event);

      case 'dedicatedaccount.assign.success':
        return this.parseAccountAssignment(event);

      case 'dedicatedaccount.assign.failed':
        return {
          providerEventId: this.eventId(event),
          rawEventType: event.event,
          kind: WebhookEventKind.AccountAssignmentFailed,
          accountAssignment: { userId: this.userIdFrom(event.data) },
        } as NormalisedWebhookEvent;

      default:
        // Paystack sends many events we have no use for (transfer.*, invoice.*).
        // Recording them as ignored keeps the audit trail complete and makes it
        // obvious when a new event type starts arriving.
        return {
          providerEventId: this.eventId(event),
          rawEventType: event.event,
          kind: WebhookEventKind.Ignored,
        };
    }
  }

  /**
   * `charge.success` covers both card payments and bank transfers into a
   * dedicated account. Only the latter funds a wallet, so the channel is checked.
   */
  private parseCharge(event: PaystackWebhookPayload): NormalisedWebhookEvent {
    const data = event.data;
    const channel = typeof data.channel === 'string' ? data.channel : '';

    if (channel !== 'dedicated_nuban' && channel !== 'bank_transfer') {
      return {
        providerEventId: this.eventId(event),
        rawEventType: event.event,
        kind: WebhookEventKind.Ignored,
      };
    }

    const reference = typeof data.reference === 'string' ? data.reference : undefined;
    if (!reference) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Funding event carried no transaction reference',
      });
    }

    // Paystack sends amounts in kobo already — no conversion, and deliberately
    // no float arithmetic anywhere on this path.
    const amount = Money.fromKobo(
      typeof data.amount === 'number'
        ? BigInt(Math.trunc(data.amount))
        : BigInt(String(data.amount)),
      typeof data.currency === 'string' ? data.currency : 'NGN',
    );

    const authorization = (data.authorization ?? {}) as Record<string, unknown>;
    const destination = (data.metadata ?? {}) as Record<string, unknown>;
    const receiver = (authorization.receiver_bank_account_number ??
      destination.receiver_account_number) as string | undefined;

    return {
      providerEventId: this.eventId(event),
      rawEventType: event.event,
      kind: WebhookEventKind.FundingReceived,
      transfer: {
        reference,
        amount,
        destinationAccountNumber: typeof receiver === 'string' ? receiver : undefined,
        senderName:
          typeof authorization.sender_name === 'string' ? authorization.sender_name : undefined,
        senderBank:
          typeof authorization.sender_bank === 'string' ? authorization.sender_bank : undefined,
        paidAt: typeof data.paid_at === 'string' ? new Date(data.paid_at) : undefined,
      },
    };
  }

  private parseAccountAssignment(event: PaystackWebhookPayload): NormalisedWebhookEvent {
    const data = event.data;
    const account = (data.dedicated_account ?? {}) as Record<string, unknown>;
    const bank = (account.bank ?? {}) as Record<string, unknown>;

    return {
      providerEventId: this.eventId(event),
      rawEventType: event.event,
      kind: WebhookEventKind.AccountAssigned,
      accountAssignment: {
        userId: this.userIdFrom(data),
        account: {
          provider: BankAccountProvider.PAYSTACK,
          reference: str(account.id),
          bankName: str(bank.name),
          bankCode: str(bank.slug),
          accountName: str(account.account_name),
          accountNumber: str(account.account_number),
          currency: str(account.currency, 'NGN'),
          raw: data,
        },
      },
    };
  }

  /** Our user id, echoed back in the customer metadata we set at creation. */
  private userIdFrom(data: Record<string, unknown>): string | undefined {
    const customer = (data.customer ?? {}) as Record<string, unknown>;
    const metadata = (customer.metadata ?? data.metadata ?? {}) as Record<string, unknown>;
    return typeof metadata.userId === 'string' ? metadata.userId : undefined;
  }

  /**
   * Paystack does not send a dedicated event id, so the transaction id (or
   * reference) stands in as the deduplication key.
   */
  private eventId(event: PaystackWebhookPayload): string | undefined {
    const id = event.data.id;
    if (typeof id === 'number' || typeof id === 'string') {
      return `${event.event}:${id}`;
    }
    const reference = event.data.reference;
    return typeof reference === 'string' ? `${event.event}:${reference}` : undefined;
  }

  // ===========================================================================
  //  HTTP
  // ===========================================================================

  /**
   * One outbound call to Paystack.
   *
   * Uses `fetch` with an `AbortSignal` timeout: an outbound call with no deadline
   * will eventually hold a request (or a queue worker) open indefinitely when the
   * provider degrades, and that is how one slow dependency saturates a service.
   */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.config.payments.paystack.baseUrl}${path}`;
    const started = Date.now();
    const operation = `paystack${path.replace(/\//g, '_')}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.payments.paystack.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.payments.httpTimeoutMs),
      });
    } catch (cause) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'error' });

      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new AppException(timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR, {
        message: 'The payment provider could not be reached',
        cause,
        retryable: true,
      });
    } finally {
      this.metrics.whatsappApiDuration.observe({ operation }, (Date.now() - started) / 1000);
    }

    const payload = (await response.json().catch(() => null)) as PaystackEnvelope<T> | null;

    if (!response.ok || !payload?.status) {
      this.metrics.whatsappApiCallsTotal.inc({ operation, status: String(response.status) });

      this.logger.error(
        { status: response.status, path, providerMessage: payload?.message },
        'Paystack request failed',
      );

      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'The payment provider rejected the request',
        // The provider's message is safe to surface: it explains *why* (invalid
        // bank, unverified business) and is what support will need. It carries no
        // secret — the credential lives only in the Authorization header.
        details: { providerMessage: payload?.message ?? `HTTP ${response.status}` },
        // 4xx is our mistake and will fail identically on retry; 5xx may not.
        retryable: response.status >= 500,
      });
    }

    this.metrics.whatsappApiCallsTotal.inc({ operation, status: 'success' });
    return payload.data;
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
