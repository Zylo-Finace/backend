import type { BankAccountProvider } from '@prisma/client';

import type { Money } from '../../core/money/money';

/** Details needed to issue a dedicated virtual account. */
export interface VirtualAccountRequest {
  userId: string;
  /** Name as held by the customer's bank. Providers validate this against BVN. */
  fullName: string;
  email: string;
  phoneE164: string;
  /**
   * Verified Bank Verification Number, digits only.
   *
   * Optional on this interface because providers differ: Paystack resolves the
   * customer's identity itself and never sees ours, while PayVessel's partner
   * banks will not issue a permanent NUBAN without one. Adapters that require it
   * fail loudly when it is absent rather than silently issuing a lesser account.
   */
  bvn?: string;
  /** Verified National Identification Number, digits only. Accepted where a BVN is unavailable. */
  nin?: string;
}

/** Details needed to issue a single-use account for one expected payment. */
export interface DynamicAccountRequest {
  /** Our reference for the payment this account collects — the on-ramp order. */
  orderRef: string;
  /** Name to display to the payer. Not identity-checked; dynamic accounts need no BVN. */
  fullName: string;
  email: string;
  phoneE164: string;
}

/**
 * A provider that can additionally issue single-use accounts.
 *
 * Separate from {@link PaymentProvider} because it is a genuine capability
 * split, not an oversight: Paystack has no equivalent, and widening the base
 * interface would force every adapter to implement a method most cannot honour.
 * Callers that need one-time collection depend on this narrower type and get a
 * boot-time failure if the configured provider does not offer it.
 */
export interface DynamicAccountProvider {
  readonly name: BankAccountProvider;
  createDynamicAccount(request: DynamicAccountRequest): Promise<VirtualAccount>;
}

/** DI token for a provider that can issue single-use accounts. */
export const DYNAMIC_ACCOUNT_PROVIDER = Symbol('DYNAMIC_ACCOUNT_PROVIDER');

/** A dedicated (virtual) NUBAN issued to one customer. */
export interface VirtualAccount {
  provider: BankAccountProvider;
  /** Provider's identifier for this account — the webhook join key. */
  reference: string;
  bankName: string;
  bankCode: string;
  accountName: string;
  /** 10-digit NUBAN. */
  accountNumber: string;
  currency: string;
  /**
   * When the account stops accepting payment. Single-use accounts only.
   *
   * Load-bearing rather than informational: money sent to an expired dynamic
   * account is refunded to the sender by the provider, so an account advertised
   * past this instant collects nothing while appearing to work.
   */
  expiresAt?: Date;
  /** Verbatim provisioning response, retained for support and disputes. */
  raw: Record<string, unknown>;
}

/** A provider event normalised into terms this platform understands. */
export interface NormalisedWebhookEvent {
  /** Provider's event id, used for deduplication. May be absent on some providers. */
  providerEventId?: string;
  /** Provider's own event name, stored verbatim for auditing. */
  rawEventType: string;
  kind: WebhookEventKind;
  /** Present when the event moves money. */
  transfer?: {
    /** Provider's transaction reference. Becomes the ledger idempotency key. */
    reference: string;
    amount: Money;
    /** NUBAN the money landed in — how we find the owner. */
    destinationAccountNumber?: string;
    /** Provider's virtual-account reference, when supplied. */
    destinationAccountReference?: string;
    /** Payer details, for the statement narration. */
    senderName?: string;
    senderBank?: string;
    paidAt?: Date;
  };
  /** Present when the event reports a newly issued virtual account. */
  accountAssignment?: {
    /** Our `userId`, echoed back in the provider's customer metadata. */
    userId?: string;
    account: VirtualAccount;
  };
}

export enum WebhookEventKind {
  /** Money arrived in a customer's dedicated account. */
  FundingReceived = 'funding.received',
  /** A dedicated account finished provisioning. */
  AccountAssigned = 'account.assigned',
  /** Account provisioning failed. */
  AccountAssignmentFailed = 'account.assignment_failed',
  /** Recognised but not acted upon. */
  Ignored = 'ignored',
}

/**
 * A payment provider that can issue Nigerian virtual accounts and notify us of
 * inbound transfers.
 *
 * ## Why an interface rather than calling Paystack directly
 *
 * Provider choice in this market is not permanent: pricing changes, settlement
 * reliability varies, and a business that grows will want a second provider for
 * redundancy. Each has a different API shape, a different signature scheme and a
 * different event vocabulary. Confining those differences to an adapter means
 * switching providers touches one file, not the wallet service, the webhook
 * controller and every test.
 *
 * The interface deliberately speaks in *our* vocabulary ({@link Money},
 * {@link WebhookEventKind}) rather than theirs — an abstraction that leaks the
 * provider's field names has not abstracted anything.
 */
export interface PaymentProvider {
  readonly name: BankAccountProvider;

  /**
   * Issues a dedicated virtual account for a customer.
   *
   * Expected to be slow (a round trip to the provider, sometimes to a bank) and
   * occasionally to fail. Callers must treat it as retryable and must never block
   * customer registration on it.
   */
  createVirtualAccount(request: VirtualAccountRequest): Promise<VirtualAccount>;

  /**
   * Verifies a webhook signature against the raw request body.
   *
   * **Must be given the exact bytes received.** Re-serialising parsed JSON
   * reorders keys and changes whitespace, which changes the HMAC and makes every
   * legitimate webhook fail verification.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;

  /** Translates a provider payload into a {@link NormalisedWebhookEvent}. */
  parseEvent(payload: unknown): NormalisedWebhookEvent;
}

/** DI token for the configured provider. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
