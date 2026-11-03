import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  LedgerEntryType,
  PayoutStatus,
  Prisma,
  WebhookEventStatus,
  type Payout,
} from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { ActorType, RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { CacheNamespace } from '../../infrastructure/cache/cache-key';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../../infrastructure/database/prisma.service';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WalletService } from '../wallet/wallet.service';
import {
  type Bank,
  type NormalisedPayoutEvent,
  PAYOUT_PROVIDER,
  PayoutEventStatus,
  type PayoutProvider,
  type ResolvedAccount,
} from './payout-provider.interface';
import { cleanBankDisplayName } from './bank-display-name';

export { cleanBankDisplayName } from './bank-display-name';

/** What a customer asks for when they withdraw. */
export interface PayoutRequestParams {
  userId: string;
  amount: Money;
  bankCode: string;
  accountNumber: string;
  narration?: string;
  /**
   * Client-supplied idempotency key. Two submissions carrying the same key
   * produce one transfer — see {@link PayoutService.requestPayout}.
   */
  idempotencyKey?: string;
}

/** The bank list changes rarely; an hour of staleness costs nothing. */
const BANK_LIST_TTL_SECONDS = 3_600;

/**
 * Outward transfers: withdrawals from a customer's wallet to their bank.
 *
 * ## The invariant
 *
 * **At no point may money be spendable and in flight at the same time, and at no
 * point may it be neither.** Every decision below follows from that:
 *
 * 1. Funds are held *before* the provider is called. Calling first and holding
 *    after leaves a window in which a second request sees the full balance.
 * 2. The `Payout` row is written *before* the provider is called, so a crash
 *    mid-call leaves a record that something was attempted. A payout row with no
 *    provider reference is recoverable; a provider transfer with no local row is
 *    not.
 * 3. A hold is only released on **proof** the transfer failed. An ambiguous
 *    outcome — a timeout, a lost response — parks the payout in
 *    `REQUIRES_REVIEW` with the hold intact. Money stuck pending a human is
 *    recoverable; money released against a transfer that actually went through
 *    is gone.
 *
 * ## Why the provider call is not inside the database transaction
 *
 * It would be the obvious way to make hold-and-submit atomic, and it is the
 * wrong one: an HTTP call inside a transaction holds the wallet row lock open
 * for the provider's entire latency, so one slow response blocks every
 * subsequent operation on that wallet. The hold commits first, and the payout
 * row's status is what records whether the submission that followed succeeded.
 */
@Injectable()
export class PayoutService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly cache: CacheService,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(PayoutService.name);
  }

  // ===========================================================================
  //  Reference data
  // ===========================================================================

  /**
   * Supported destination banks.
   *
   * Cached globally rather than per tenant: the list is a property of the
   * Nigerian banking system, identical for everyone, and the upstream limit is
   * 60 requests a minute across the whole business.
   */
  async listBanks(): Promise<Bank[]> {
    return this.cache.remember(
      this.cache.keys.global(CacheNamespace.Bank, this.provider.name, 'list'),
      BANK_LIST_TTL_SECONDS,
      () => this.provider.listBanks(),
    );
  }

  /**
   * Name enquiry, shown to the customer before they confirm.
   *
   * The bank code is checked against the supported list first, so an unknown
   * code produces a clear 422 instead of an opaque provider error.
   */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    await this.requireBank(bankCode);
    return this.provider.resolveAccount(accountNumber, bankCode);
  }

  // ===========================================================================
  //  Requesting a payout
  // ===========================================================================

  /**
   * Holds the funds and hands the transfer to the provider.
   *
   * Returns as soon as the provider has *accepted* the instruction. The customer
   * must be told "on its way", never "sent" — the outcome arrives on a webhook,
   * and telling them it succeeded before it has is how a failed transfer becomes
   * a support ticket about missing money.
   *
   * ## Idempotency
   *
   * `idempotencyKey` is hashed into the transfer reference, so a resubmitted
   * form, a proxy retry or a double-tap all resolve to the same reference — and
   * therefore to the same hold, the same `Payout` row, and the same upstream
   * transfer. Without a key each attempt gets a fresh reference and a second
   * transfer really is created, which is the correct reading of a request that
   * gave us no way to recognise it as a repeat.
   */
  async requestPayout(params: PayoutRequestParams): Promise<Payout> {
    const tenantId = RequestContext.requireTenantId();

    this.assertWithinLimits(params.amount);

    const reference = this.reference(params.idempotencyKey);

    // A replay of a request we have already acted on. Returned as-is rather than
    // re-submitted: the transfer exists, and its status is whatever the webhook
    // has told us since.
    const existing = await this.db.payout.findFirst({ where: { reference } });
    if (existing) {
      this.logger.info(
        { reference, payoutId: existing.id, status: existing.status },
        'Payout already exists for this idempotency key; returning the original',
      );
      return existing;
    }

    const bank = await this.requireBank(params.bankCode);

    // The authoritative recipient name comes from the bank, never from the
    // customer's typing. A transposed digit that happens to be a live account
    // pays a stranger, and NIP transfers do not come back.
    const resolved = await this.provider.resolveAccount(params.accountNumber, params.bankCode);

    const narration = (params.narration ?? 'Wallet withdrawal').slice(0, 100);

    // ---------------------------------------------------------------------
    // 1. Reserve the funds. Throws INSUFFICIENT_BALANCE before anything is
    //    written or sent, which is the cheapest place to fail.
    // ---------------------------------------------------------------------
    const hold = await this.wallet.hold({
      userId: params.userId,
      amount: params.amount,
      type: LedgerEntryType.WITHDRAWAL,
      reference,
      narration: `Withdrawal to ${resolved.accountName} · ${cleanBankDisplayName(bank.name)}`,
    });

    // ---------------------------------------------------------------------
    // 2. Record the attempt before making it.
    // ---------------------------------------------------------------------
    const payout = await this.db.payout.create({
      data: {
        tenantId,
        userId: params.userId,
        provider: this.provider.name,
        status: PayoutStatus.PENDING,
        reference,
        amount: params.amount.kobo,
        currency: params.amount.currency,
        bankCode: params.bankCode,
        bankName: bank.name,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName,
        narration,
        ledgerEntryId: hold.entryId,
      },
    });

    // ---------------------------------------------------------------------
    // 3. Submit. Everything past here is about classifying the failure
    //    correctly — the difference between "definitely not sent" and "we do
    //    not know" is the difference between a refund and a double payment.
    // ---------------------------------------------------------------------
    try {
      const acceptance = await this.provider.initiateTransfer({
        reference,
        amount: params.amount,
        bankCode: params.bankCode,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName,
        narration,
      });

      const submitted = await this.db.payout.update({
        where: { id: payout.id },
        data: {
          status: PayoutStatus.PROCESSING,
          providerReference: acceptance.providerReference,
          sessionId: acceptance.sessionId,
          submittedAt: new Date(),
          metadata: { acceptance: acceptance.raw } as Prisma.InputJsonValue,
        },
      });

      this.metrics.messagesTotal.inc({
        direction: 'outbound',
        type: 'payout',
        status: 'submitted',
      });

      this.logger.info(
        {
          payoutId: payout.id,
          reference,
          providerReference: acceptance.providerReference,
          amount: params.amount.toDecimalString(),
        },
        'Payout accepted by the provider; awaiting confirmation',
      );

      const terminal = this.provider.parseTransferResponse?.(acceptance.raw, reference) ?? null;
      if (terminal) {
        await this.reconcileTerminalEvent(terminal);
        const refreshed = await this.db.payout.findFirst({ where: { reference } });
        return refreshed ?? submitted;
      }

      return submitted;
    } catch (error) {
      return this.onSubmissionFailed(payout, error);
    }
  }

  /**
   * Decides what a failed submission means for the customer's money.
   *
   * Three outcomes, and getting them the wrong way round is expensive:
   *
   * - **Duplicate reference** — the provider already has this transfer. It is in
   *   flight; the hold stays and we wait for the webhook exactly as if the call
   *   had succeeded.
   * - **Unknown outcome** (timeout, lost response) — the instruction may or may
   *   not have been queued. The hold stays, and a human decides. Nothing is
   *   automatic here on purpose.
   * - **Rejected** — the provider refused it and no money moved. Only here is it
   *   safe to give the funds back.
   */
  private async onSubmissionFailed(payout: Payout, error: unknown): Promise<Payout> {
    const code = error instanceof AppException ? error.code : undefined;
    const reason = error instanceof Error ? error.message : String(error);

    if (code === ErrorCode.PAYOUT_DUPLICATE_REFERENCE) {
      this.logger.warn(
        { payoutId: payout.id, reference: payout.reference },
        'Provider already had this transfer; treating as submitted',
      );
      return this.db.payout.update({
        where: { id: payout.id },
        data: { status: PayoutStatus.PROCESSING, submittedAt: new Date() },
      });
    }

    if (code === ErrorCode.PAYOUT_UNKNOWN_OUTCOME) {
      this.metrics.messagesTotal.inc({
        direction: 'outbound',
        type: 'payout',
        status: 'unknown',
      });

      // Loud on purpose: this is the one state that cannot resolve itself.
      this.logger.error(
        { payoutId: payout.id, reference: payout.reference, reason },
        'Payout outcome is unknown; funds remain held pending manual review',
      );

      await this.db.payout.update({
        where: { id: payout.id },
        data: {
          status: PayoutStatus.REQUIRES_REVIEW,
          submittedAt: new Date(),
          failureReason: reason.slice(0, 512),
        },
      });

      throw error;
    }

    // A definite rejection. The money never left, so the hold must not stand.
    this.metrics.messagesTotal.inc({
      direction: 'outbound',
      type: 'payout',
      status: 'rejected',
    });

    this.logger.warn(
      { payoutId: payout.id, reference: payout.reference, reason },
      'Provider rejected the payout; releasing the hold',
    );

    // If the release itself fails the hold survives, which is the safe side of
    // this failure — the customer's money is intact, merely unavailable, and the
    // payout is left in a state an operator can see.
    await this.wallet.release(payout.reference, reason).catch((releaseError: unknown) => {
      this.logger.error(
        { payoutId: payout.id, reference: payout.reference, err: releaseError },
        'Failed to release the hold after a rejected payout; manual review required',
      );
    });

    await this.db.payout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.FAILED,
        completedAt: new Date(),
        failureReason: reason.slice(0, 512),
      },
    });

    throw error;
  }

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  /**
   * Applies a verified status webhook.
   *
   * The event is persisted before it is acted upon, so a crash mid-processing
   * leaves evidence that it arrived rather than losing it entirely. Mirrors
   * {@link FundingService.handle} deliberately — one shape for webhook handling
   * across the codebase, so the next provider's handler is recognisable.
   */
  async handleWebhook(
    rawPayload: unknown,
    signature: string | undefined,
    event: NormalisedPayoutEvent,
  ): Promise<{ status: WebhookEventStatus; eventId: string; duplicate?: boolean }> {
    const stored = await this.record(rawPayload, signature, event);

    if (stored.alreadyProcessed) {
      return { status: WebhookEventStatus.PROCESSED, eventId: stored.id, duplicate: true };
    }

    try {
      const outcome = await this.apply(event);

      await this.prisma.webhookEvent.update({
        where: { id: stored.id },
        data: {
          status: outcome.status,
          tenantId: outcome.tenantId,
          ledgerEntryId: outcome.ledgerEntryId,
          processedAt: new Date(),
          attempts: { increment: 1 },
        },
      });

      return { status: outcome.status, eventId: stored.id, duplicate: outcome.duplicate };
    } catch (error) {
      await this.prisma.webhookEvent
        .update({
          where: { id: stored.id },
          data: {
            status: WebhookEventStatus.FAILED,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
            attempts: { increment: 1 },
          },
        })
        // Never let the bookkeeping failure mask the original error.
        .catch(() => undefined);

      throw error;
    }
  }

  /**
   * Persists the event, deduplicating on the provider's reference and status.
   *
   * FalconPay sends no event id, so the dedup key is composed: the same payout
   * legitimately produces a `processing` event and then a `completed` one, and
   * keying on the reference alone would discard the second.
   */
  private async record(
    rawPayload: unknown,
    signature: string | undefined,
    event: NormalisedPayoutEvent,
  ): Promise<{ id: string; alreadyProcessed: boolean }> {
    const providerEventId = `${event.reference}:${event.status}`;

    return RequestContext.runAsSystem({}, async () => {
      const existing = await this.prisma.webhookEvent.findUnique({
        where: {
          provider_providerEventId: { provider: this.provider.name, providerEventId },
        },
        select: { id: true, status: true },
      });

      if (existing) {
        return {
          id: existing.id,
          // A previously FAILED event is retried; a completed one is not.
          alreadyProcessed:
            existing.status === WebhookEventStatus.PROCESSED ||
            existing.status === WebhookEventStatus.IGNORED,
        };
      }

      const created = await this.prisma.webhookEvent.create({
        data: {
          provider: this.provider.name,
          eventType: event.rawEventType,
          providerEventId,
          payload: rawPayload as never,
          signature: signature?.slice(0, 512),
          status: WebhookEventStatus.RECEIVED,
        },
        select: { id: true },
      });

      return { id: created.id, alreadyProcessed: false };
    });
  }

  /** Moves the payout — and the customer's held funds — to their end state. */
  private async apply(event: NormalisedPayoutEvent): Promise<{
    status: WebhookEventStatus;
    tenantId?: string;
    ledgerEntryId?: string;
    duplicate?: boolean;
  }> {
    if (event.status === PayoutEventStatus.Ignored) {
      return { status: WebhookEventStatus.IGNORED };
    }

    // Unscoped by necessity — the tenant is precisely what we are trying to
    // discover — and it looks up our own generated reference rather than
    // anything the caller controls.
    const payout = await RequestContext.runAsSystem({}, async () =>
      this.prisma.payout.findFirst({
        where: { reference: event.reference },
        select: { id: true, tenantId: true, userId: true, status: true, reference: true },
      }),
    );

    if (!payout) {
      // A status for a transfer we have no record of. Either a reference
      // collision with another integration or a lost write — both need a human.
      this.logger.error(
        { reference: event.reference, providerReference: event.providerReference },
        'Payout webhook for an unknown reference',
      );
      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
        message: 'No payout matches this reference',
      });
    }

    return RequestContext.run(
      {
        tenantId: payout.tenantId,
        actorType: ActorType.Webhook,
        correlationId: RequestContext.correlationId,
      },
      async () => {
        // `processing` carries no money decision — record the provider's
        // identifiers and wait for a terminal event.
        if (event.status === PayoutEventStatus.Processing) {
          await this.db.payout.update({
            where: { id: payout.id },
            data: {
              // Never walk a terminal payout back to PROCESSING: events can
              // arrive out of order, and a `processing` delivered after a
              // `completed` must not undo the settlement.
              ...(payout.status === PayoutStatus.PENDING ||
              payout.status === PayoutStatus.REQUIRES_REVIEW
                ? { status: PayoutStatus.PROCESSING }
                : {}),
              providerReference: event.providerReference,
              sessionId: event.sessionId,
            },
          });
          return { status: WebhookEventStatus.PROCESSED, tenantId: payout.tenantId };
        }

        const completed = event.status === PayoutEventStatus.Completed;

        // The wallet call is the one that must be idempotent, and it is: closing
        // an already-closed hold with the same outcome is a no-op, and with a
        // conflicting outcome it raises rather than moving money twice.
        const movement = completed
          ? await this.wallet.settle(payout.reference)
          : await this.wallet.release(payout.reference, event.message);

        await this.db.payout.update({
          where: { id: payout.id },
          data: {
            status: completed ? PayoutStatus.COMPLETED : PayoutStatus.FAILED,
            providerReference: event.providerReference,
            sessionId: event.sessionId,
            completedAt: new Date(),
            ...(completed ? {} : { failureReason: event.message?.slice(0, 512) }),
          },
        });

        this.metrics.messagesTotal.inc({
          direction: 'outbound',
          type: 'payout',
          status: completed ? 'completed' : 'failed',
        });

        this.logger.info(
          {
            payoutId: payout.id,
            reference: payout.reference,
            userId: payout.userId,
            duplicate: movement.duplicate,
          },
          completed ? 'Payout completed; funds debited' : 'Payout failed; funds returned',
        );

        return {
          status: WebhookEventStatus.PROCESSED,
          tenantId: payout.tenantId,
          ledgerEntryId: movement.entryId,
          duplicate: movement.duplicate,
        };
      },
    );
  }

  // ===========================================================================
  //  Helpers
  // ===========================================================================

  /**
   * Applies a terminal provider status when webhooks are missing or delayed.
   * Used by the bank-send reconciler and synchronous transfer responses.
   */
  async reconcileTerminalEvent(event: NormalisedPayoutEvent): Promise<boolean> {
    if (event.status !== PayoutEventStatus.Completed && event.status !== PayoutEventStatus.Failed) {
      return false;
    }

    try {
      await this.handleWebhook(
        { source: 'reconcile', reference: event.reference, status: event.status },
        undefined,
        event,
      );
      return true;
    } catch (error) {
      if (error instanceof AppException && error.code === ErrorCode.RESOURCE_NOT_FOUND) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Polls the payout provider for a terminal status and applies it.
   */
  async pollTransferStatus(reference: string): Promise<boolean> {
    const event = await this.provider.fetchTransferStatus?.(reference);
    if (!event) return false;
    return this.reconcileTerminalEvent(event);
  }

  /**
   * Enforces our own per-transfer bounds, in whole naira.
   *
   * The ceiling exists to cap the blast radius of a compromised session or a
   * unit bug, and it is checked here rather than only in the DTO so that every
   * caller — HTTP, WhatsApp command, future queue worker — gets it.
   */
  private assertWithinLimits(amount: Money): void {
    const { minAmountNaira, maxAmountNaira } = this.config.payouts;
    const min = Money.fromNaira(minAmountNaira, amount.currency);
    const max = Money.fromNaira(maxAmountNaira, amount.currency);

    if (amount.lessThan(min)) {
      throw new AppException(ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED, {
        message: `The minimum withdrawal is ${min.format()}`,
        details: { minimum: min.toDecimalString(), requested: amount.toDecimalString() },
      });
    }

    if (amount.greaterThan(max)) {
      throw new AppException(ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED, {
        message: `The maximum withdrawal is ${max.format()}`,
        details: { maximum: max.toDecimalString(), requested: amount.toDecimalString() },
      });
    }

    // FalconPay accepts whole naira only. Caught here so the customer gets a
    // clear message instead of a provider rejection after the hold is placed.
    if (amount.kobo % 100n !== 0n) {
      throw new AppException(ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED, {
        message: 'Withdrawals must be a whole number of naira',
        details: { requested: amount.toDecimalString() },
      });
    }
  }

  /** Resolves a bank code against the supported list. */
  private async requireBank(bankCode: string): Promise<Bank> {
    const banks = await this.listBanks();
    const bank = banks.find((candidate) => candidate.code === bankCode);

    if (!bank) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'That bank is not supported for transfers',
        details: { bankCode },
      });
    }

    return bank;
  }

  /**
   * Builds the transfer reference — our idempotency key, and the provider's.
   *
   * Derived from the client's key by hash rather than used directly: the key is
   * caller-controlled text, and it ends up in a `VarChar(128)` column, in a URL
   * path on the provider's side, and in logs. Hashing gives a fixed-length,
   * charset-safe value and keeps whatever the client chose to put in the key out
   * of those places.
   */
  private reference(idempotencyKey: string | undefined): string {
    const suffix = idempotencyKey
      ? createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
      : randomUUID().replaceAll('-', '');

    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `PAY-${date}-${suffix}`;
  }
}
