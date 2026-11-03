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
  type DynamicAccountProvider,
  type DynamicAccountRequest,
  type NormalisedWebhookEvent,
  type PaymentProvider,
  type VirtualAccount,
  type VirtualAccountRequest,
  WebhookEventKind,
} from './payment-provider.interface';
import { PayVesselApi, PayVesselClient } from './payvessel.client';

/** Reserved-account issuance. */
const CREATE_ACCOUNT_PATH = '/pms/api/external/request/customerReservedAccount/';

/** One issued NUBAN, as PayVessel describes it. */
interface PayVesselBank {
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  account_type?: string;
  expire_date?: string;
  trackingReference?: string;
}

/**
 * Account-creation envelope.
 *
 * `banks` is an array for STATIC accounts (one entry per partner bank requested)
 * and a bare object for DYNAMIC ones. That inconsistency is theirs; it is
 * normalised on the way in and never leaks past this file.
 */
interface CreateAccountResponse {
  status?: boolean;
  service?: string;
  business?: string;
  banks?: PayVesselBank[] | PayVesselBank;
  message?: string;
}

/** Inbound notification. See {@link parseEvent} for the field-probing rationale. */
interface PayVesselWebhookPayload {
  event?: string;
  order?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * PayVessel adapter — Nigerian reserved accounts, static and dynamic.
 *
 * ## Why this provider exists alongside Paystack
 *
 * PayVessel offers the one thing the wallet product needs and Paystack does not:
 * **single-use** accounts. An on-ramp customer converting naira to crypto should
 * pay into an account that belongs to that one order, expires, and cannot be
 * paid into twice — otherwise a second transfer to a saved account number
 * arrives with no order to fulfil and has to be found and refunded by hand.
 *
 * ## Static accounts require verified identity
 *
 * The partner bank, not PayVessel, refuses to issue a permanent NUBAN without a
 * BVN or NIN. That is why {@link createVirtualAccount} throws rather than
 * degrading: an account issued against unverified identity is a compliance
 * problem that surfaces months later, during an audit, on every account opened
 * in the interim.
 */
@Injectable()
export class PayVesselProvider implements PaymentProvider, DynamicAccountProvider {
  readonly name = BankAccountProvider.PAYVESSEL;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: PayVesselClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PayVesselProvider.name);
  }

  // ===========================================================================
  //  Provisioning
  // ===========================================================================

  /**
   * Issues a permanent NUBAN for a KYC-verified customer.
   *
   * Requests every configured partner bank in one call. PayVessel answers with
   * one account per bank; the first is stored as *the* funding account and the
   * rest are kept in `raw` so support can quote an alternative when a customer's
   * bank rejects transfers to one of them.
   */
  async createVirtualAccount(request: VirtualAccountRequest): Promise<VirtualAccount> {
    const bvn = digitsOnly(request.bvn);
    const nin = digitsOnly(request.nin);

    if (!bvn && !nin) {
      throw new AppException(ErrorCode.PRECONDITION_FAILED, {
        message: 'A verified BVN or NIN is required before a permanent account can be issued',
        retryable: false,
      });
    }

    const settings = this.config.payments.payvessel;

    const response = await this.client.request<CreateAccountResponse>({
      method: 'POST',
      api: PayVesselApi.Payments,
      path: CREATE_ACCOUNT_PATH,
      body: {
        email: request.email,
        name: request.fullName,
        phoneNumber: request.phoneE164,
        bankcode: settings.staticBankCodes,
        account_type: 'STATIC',
        businessid: this.client.businessId,
        ...(bvn ? { bvn } : {}),
        ...(nin ? { nin } : {}),
      },
    });

    const accounts = this.readAccounts(response.body);

    this.logger.info(
      { userId: request.userId, banks: accounts.length },
      'PayVessel issued a permanent account',
    );

    return accounts[0]!;
  }

  /**
   * Issues a single-use NUBAN for one expected payment.
   *
   * No identity is sent: dynamic accounts carry no BVN requirement, which is
   * precisely what makes them the right instrument for a customer who has not
   * completed KYC yet.
   */
  async createDynamicAccount(request: DynamicAccountRequest): Promise<VirtualAccount> {
    const settings = this.config.payments.payvessel;

    const response = await this.client.request<CreateAccountResponse>({
      method: 'POST',
      api: PayVesselApi.Payments,
      path: CREATE_ACCOUNT_PATH,
      body: {
        email: request.email,
        name: request.fullName,
        phoneNumber: request.phoneE164,
        // Exactly one code: the payer is shown one account, and asking for two
        // would leave a second live NUBAN nobody is watching.
        bankcode: [settings.dynamicBankCode],
        account_type: 'DYNAMIC',
        businessid: this.client.businessId,
      },
    });

    const account = this.readAccounts(response.body)[0]!;

    if (!account.expiresAt) {
      // Not fatal — the caller applies its own TTL — but worth knowing about,
      // because our expiry and theirs disagreeing is how a customer pays into a
      // dead account.
      this.logger.warn(
        { orderRef: request.orderRef, reference: account.reference },
        'PayVessel returned a dynamic account with no expiry',
      );
    }

    return account;
  }

  /**
   * Fetches an account by NUBAN. Used to reconcile a credit whose destination we
   * do not recognise, before escalating it to a human.
   */
  async getVirtualAccount(accountNumber: string): Promise<Record<string, unknown>> {
    const response = await this.client.request<Record<string, unknown>>({
      method: 'GET',
      api: PayVesselApi.Payments,
      path: `/pms/api/external/request/virtual-account/${encodeURIComponent(
        this.client.businessId,
      )}/${encodeURIComponent(accountNumber)}/`,
    });
    return response.body;
  }

  /** Normalises the `banks` array-or-object into our own shape. */
  private readAccounts(body: CreateAccountResponse): VirtualAccount[] {
    const banks = Array.isArray(body.banks) ? body.banks : body.banks ? [body.banks] : [];

    const accounts = banks
      .filter((bank) => typeof bank?.accountNumber === 'string' && bank.accountNumber.length > 0)
      .map((bank) => ({
        provider: BankAccountProvider.PAYVESSEL,
        reference: str(bank.trackingReference),
        bankName: str(bank.bankName),
        bankCode: str(bank.bankCode),
        accountName: str(bank.accountName),
        accountNumber: str(bank.accountNumber),
        currency: 'NGN',
        expiresAt: parseDate(bank.expire_date),
        raw: body as unknown as Record<string, unknown>,
      }));

    if (accounts.length === 0 || !accounts[0]!.reference) {
      // A 200 with no usable account is worse than an error: storing it would
      // give a customer an account number that belongs to nobody.
      throw new AppException(ErrorCode.UPSTREAM_ERROR, {
        message: 'PayVessel returned no usable account',
        details: { providerMessage: body.message ?? 'response carried no account number' },
        retryable: true,
      });
    }

    return accounts;
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /**
   * Verifies `HTTP_PAYVESSEL_HTTP_SIGNATURE`: HMAC-SHA512 of the raw body, keyed
   * with the API secret.
   *
   * PayVessel signs with the same secret that authenticates outbound calls, so
   * there is no separate webhook secret to configure — and rolling the API key
   * silently invalidates in-flight deliveries.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;

    const secret = this.config.payments.payvessel.apiSecret;
    if (!secret) {
      // Fail closed. An unconfigured secret must never mean "accept everything".
      this.logger.error('PayVessel API secret is not configured; rejecting webhook');
      return false;
    }

    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const provided = signature.trim().toLowerCase();

    // Length is checked first because `timingSafeEqual` throws on a mismatch;
    // the length itself is not a secret.
    if (expected.length !== provided.length) return false;

    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  }

  /**
   * Confirms a request came from a PayVessel address.
   *
   * Defence in depth behind the signature, and cheap. The left-most
   * `X-Forwarded-For` entry is used when present because the socket address
   * behind a load balancer is the balancer's.
   */
  isTrustedSource(ip: string | undefined): boolean {
    const settings = this.config.payments.payvessel;
    if (!settings.enforceWebhookIps) return true;
    if (!ip) return false;
    return settings.webhookIps.includes(ip.trim().replace(/^::ffff:/, ''));
  }

  /**
   * Translates a PayVessel notification into our vocabulary.
   *
   * ## On field probing
   *
   * PayVessel documents the envelope (`event`, `order`, `transaction`) and the
   * fields we settle against, but not which key carries the destination NUBAN —
   * and that key is the one thing we cannot do without, because it is how the
   * money finds an owner. Rather than guess one name and silently fail to credit
   * every customer if the guess is wrong, several plausible locations are
   * probed and a miss is escalated loudly by {@link FundingService}. When the
   * live payload is confirmed, this collapses to a single read.
   */
  parseEvent(payload: unknown): NormalisedWebhookEvent {
    const event = payload as PayVesselWebhookPayload;

    if (!event || typeof event !== 'object') {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Unrecognised webhook payload',
      });
    }

    const transaction = event.transaction ?? {};
    const order = event.order ?? {};
    const name = typeof event.event === 'string' ? event.event : inferEventName(transaction);

    if (!isCredit(name, transaction)) {
      // Debits, low-balance alerts, transfer and card events all arrive here.
      // Recording them as ignored keeps the audit trail complete and makes it
      // obvious when a new event type starts arriving.
      return {
        providerEventId: eventId(name, transaction),
        rawEventType: name,
        kind: WebhookEventKind.Ignored,
      };
    }

    const reference = firstString(transaction, [
      'reference',
      'transactionRef',
      'transaction_ref',
      'sessionid',
    ]);
    if (!reference) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Funding event carried no transaction reference',
      });
    }

    // Gross, not settlement. The customer is credited what they sent — the
    // provider's fee is the business's cost, and is carried in the ledger
    // metadata so settlement still reconciles against the bank statement.
    const gross =
      firstString(order, ['amount', 'settlement_amount']) ?? firstString(transaction, ['amount']);
    if (!gross) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Funding event carried no amount',
      });
    }

    const sender = (transaction.sender ?? {}) as Record<string, unknown>;

    return {
      providerEventId: eventId(name, transaction),
      rawEventType: name,
      kind: WebhookEventKind.FundingReceived,
      transfer: {
        reference,
        // PayVessel quotes naira as a decimal string ("1500.50"). `fromNaira`
        // parses it exactly; no float ever touches a balance.
        amount: Money.fromNaira(gross, firstString(order, ['currency']) ?? 'NGN'),
        destinationAccountNumber: firstString(transaction, [
          'account_number',
          'accountNumber',
          'receiver_account_number',
          'virtual_account_number',
        ]),
        destinationAccountReference: firstString(transaction, [
          'trackingReference',
          'tracking_reference',
          'account_reference',
        ]),
        senderName:
          firstString(sender, ['name']) ??
          firstString(transaction, ['sender_name', 'originator_name']),
        senderBank:
          firstString(sender, ['bank']) ??
          firstString(transaction, ['sender_bank', 'originator_bank']),
        paidAt: parseDate(firstString(transaction, ['paid_at', 'paidAt', 'created_at'])),
      },
    };
  }
}

/**
 * PayVessel's credit events, by name.
 *
 * `transaction.success` is theirs for "a payment completed", which for a
 * reserved account means money landed; `reserved_account.credit` is the
 * account-specific form. Both are credits.
 */
const CREDIT_EVENTS = new Set(['transaction.success', 'reserved_account.credit']);

function isCredit(name: string, transaction: Record<string, unknown>): boolean {
  if (!CREDIT_EVENTS.has(name)) return false;
  const status = firstString(transaction, ['status']);
  // An event named `success` that carries a non-success status is a
  // contradiction; trusting the name over the field would credit a failed
  // payment.
  return !status || status.toLowerCase() === 'success' || status.toLowerCase() === 'completed';
}

/**
 * PayVessel does not send an event id, so the transaction reference stands in as
 * the deduplication key — it is stable across their retries, which is the only
 * property the key needs.
 */
function eventId(name: string, transaction: Record<string, unknown>): string | undefined {
  const reference = firstString(transaction, [
    'reference',
    'transactionRef',
    'transaction_ref',
    'sessionid',
  ]);
  return reference ? `${name}:${reference}` : undefined;
}

/** Falls back to a synthetic name when the payload omits `event`. */
function inferEventName(transaction: Record<string, unknown>): string {
  const status = firstString(transaction, ['status']);
  return status ? `transaction.${status.toLowerCase()}` : 'unknown';
}

/** First key present as a non-empty primitive. */
function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  }
  return undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Coerces an untrusted provider field to a string.
 *
 * `String(value)` on a nested object yields `"[object Object]"`, which would
 * happily be stored as somebody's account number.
 */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

/** Strips formatting from an identifier. Registries hold digits only. */
function digitsOnly(value: string | undefined): string | undefined {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : undefined;
}
