import type { PayoutProviderName } from '@prisma/client';

import type { Money } from '../../core/money/money';

/** A bank that can receive a transfer, as the provider names it. */
export interface Bank {
  name: string;
  /** CBN/NIP code. The only value subsequent calls accept. */
  code: string;
}

/** The result of a name enquiry against a NUBAN. */
export interface ResolvedAccount {
  accountNumber: string;
  bankCode: string;
  /** The name the recipient's bank holds. Authoritative — never the typed one. */
  accountName: string;
}

/** An instruction to move money out to a third-party account. */
export interface PayoutRequest {
  /** Our idempotency key. The provider must reject a second use of it. */
  reference: string;
  amount: Money;
  bankCode: string;
  accountNumber: string;
  /** As returned by {@link PayoutProvider.resolveAccount}. */
  accountName: string;
  /** Shown on the recipient's bank statement. */
  narration: string;
}

/**
 * What the provider said when handed a {@link PayoutRequest}.
 *
 * Note there is no "succeeded" here, only "accepted". Acceptance is an
 * acknowledgement that the instruction was queued; the outcome arrives later on
 * a webhook. Modelling this as a success would be the single most expensive
 * mistake available on this path.
 */
export interface PayoutAcceptance {
  /** Provider's own identifier for the transfer. Key for support escalations. */
  providerReference?: string;
  /** NIP session id, when the provider returns one this early. */
  sessionId?: string;
  /** Verbatim response, retained for disputes. */
  raw: Record<string, unknown>;
}

/** Where a payout has got to, as reported by the provider. */
export enum PayoutEventStatus {
  /** Submitted downstream, outcome still unknown. */
  Processing = 'processing',
  /** Confirmed paid. Terminal — safe to settle the hold. */
  Completed = 'completed',
  /** Rejected or timed out. Terminal — release the hold. */
  Failed = 'failed',
  /** Recognised but carries no status we act on. */
  Ignored = 'ignored',
}

/** A payout status webhook, normalised into our vocabulary. */
export interface NormalisedPayoutEvent {
  /** Our reference, echoed back. The join key to the `Payout` row. */
  reference: string;
  status: PayoutEventStatus;
  /** The provider's own event name, stored verbatim for auditing. */
  rawEventType: string;
  providerReference?: string;
  sessionId?: string;
  /** Present on failure — the provider's explanation, for support and the user. */
  message?: string;
}

/**
 * A provider that can send money out to a Nigerian bank account.
 *
 * ## Why this is separate from `PaymentProvider`
 *
 * The inbound and outbound legs of a wallet are different businesses with
 * different providers, different licences and different failure modes. Paystack
 * issues the dedicated NUBANs money arrives in; FalconPay pushes money out.
 * Folding both into one interface would force every adapter to stub the half it
 * does not do, and would mean switching the payout provider churned the file
 * that provisions funding accounts.
 *
 * Like {@link PaymentProvider}, this speaks in *our* vocabulary — {@link Money},
 * {@link PayoutEventStatus} — so a provider's naira-vs-kobo convention and event
 * names never escape their adapter.
 */
export interface PayoutProvider {
  readonly name: PayoutProviderName;

  /**
   * Banks that can receive a transfer.
   *
   * Changes rarely and is read on every withdrawal screen, so callers are
   * expected to cache it. The adapter does not cache: what to do when the list
   * is briefly stale is the caller's decision, not the transport's.
   */
  listBanks(): Promise<Bank[]>;

  /**
   * Resolves a NUBAN to the name its bank holds.
   *
   * Called before every transfer, and its result — not the customer's typing —
   * is what gets sent. A mistyped account number that happens to be valid sends
   * money to a stranger, and NIP transfers are not reversible.
   */
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount>;

  /**
   * Hands a transfer instruction to the provider.
   *
   * Resolving means *accepted*, not *paid*. Callers must not settle anything
   * until a terminal webhook arrives.
   *
   * A rejection that the provider has definitely not queued throws
   * `AppException`; a timeout throws with `UPSTREAM_TIMEOUT`, which callers must
   * treat as "unknown outcome" rather than as failure.
   */
  initiateTransfer(request: PayoutRequest): Promise<PayoutAcceptance>;

  /**
   * Verifies a webhook signature against the raw request body.
   *
   * **Must be given the exact bytes received.** Re-serialising parsed JSON
   * reorders keys and changes whitespace, which changes the HMAC and makes every
   * legitimate webhook fail verification.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined, timestamp?: string): boolean;

  /** Translates a provider payload into a {@link NormalisedPayoutEvent}. */
  parseEvent(payload: unknown): NormalisedPayoutEvent;

  /**
   * Reads a terminal status from a transfer API response, when the provider
   * includes one synchronously. Optional — most adapters only learn on webhooks.
   */
  parseTransferResponse?(
    raw: Record<string, unknown>,
    reference: string,
  ): NormalisedPayoutEvent | null;

  /** Polls transfer status by our reference when webhooks are delayed or missing. */
  fetchTransferStatus?(reference: string): Promise<NormalisedPayoutEvent | null>;
}

/** DI token for the configured payout provider. */
export const PAYOUT_PROVIDER = Symbol('PAYOUT_PROVIDER');
