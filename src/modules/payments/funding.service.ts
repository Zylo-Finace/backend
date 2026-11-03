import { Inject, Injectable } from '@nestjs/common';
import { BankAccountProvider, LedgerEntryType, WebhookEventStatus } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { ActorType, RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../../infrastructure/database/prisma.service';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WalletService } from '../wallet/wallet.service';
import { OnrampAccountService } from './onramp-account.service';
import {
  PAYMENT_PROVIDER,
  type NormalisedWebhookEvent,
  type PaymentProvider,
  WebhookEventKind,
} from './payment-provider.interface';

export interface WebhookOutcome {
  status: WebhookEventStatus;
  eventId: string;
  ledgerEntryId?: string;
  duplicate?: boolean;
}

/**
 * Turns provider webhooks into wallet movements.
 *
 * ## Processed inline, not queued — and why
 *
 * The obvious "production" instinct is to acknowledge immediately and process on
 * a queue. Here that would be worse. The work is a single short, idempotent,
 * row-locked transaction that completes in milliseconds; queueing it adds a
 * durability hop where the job can be lost, and introduces a window in which the
 * provider believes we have the money but the customer's balance says otherwise.
 * Crediting inside the request means a failure is reported to the provider as a
 * non-2xx, and *their* retry — which is guaranteed and already idempotent on our
 * side — becomes the recovery mechanism.
 *
 * The seam for changing this is deliberate: {@link process} takes a stored event
 * id and is safe to call repeatedly, so moving it behind a queue later is a
 * change of caller, not a rewrite.
 *
 * ## Tenant resolution
 *
 * A webhook arrives with no tenant. The owner is found by resolving the
 * destination account, which requires an unscoped query — hence
 * `RequestContext.runAsSystem` for that step only. Once the tenant is known,
 * everything else runs inside a normal tenant-scoped context so the isolation
 * guarantees still apply to the credit itself.
 */
@Injectable()
export class FundingService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly onramp: OnrampAccountService,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(FundingService.name);
  }

  /**
   * Records a verified webhook and applies it.
   *
   * The event is persisted **before** it is acted upon, so a crash mid-processing
   * leaves evidence that it arrived rather than losing it entirely.
   */
  async handle(
    rawPayload: unknown,
    signature: string | undefined,
    event: NormalisedWebhookEvent,
    /**
     * Which provider sent this, when it is not the configured default.
     *
     * More than one integration can deliver webhooks at once — a migration
     * between providers runs both for a period — and the deduplication key is
     * `(provider, providerEventId)`. Attributing PayVessel's events to Paystack
     * would let two providers' references collide in that unique index.
     */
    providerName: BankAccountProvider = this.provider.name,
  ): Promise<WebhookOutcome> {
    const stored = await this.record(rawPayload, signature, event, providerName);

    // A redelivery of an event we have already completed: acknowledge and stop.
    if (stored.alreadyProcessed) {
      this.metrics.messagesTotal.inc({
        direction: 'inbound',
        type: 'webhook',
        status: 'duplicate',
      });
      return { status: WebhookEventStatus.PROCESSED, eventId: stored.id, duplicate: true };
    }

    try {
      const outcome = await this.apply(stored.id, event);

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

      this.metrics.messagesTotal.inc({
        direction: 'inbound',
        type: 'webhook',
        status: outcome.status.toLowerCase(),
      });

      return {
        status: outcome.status,
        eventId: stored.id,
        ledgerEntryId: outcome.ledgerEntryId,
        duplicate: outcome.duplicate,
      };
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

      this.metrics.messagesTotal.inc({
        direction: 'inbound',
        type: 'webhook',
        status: 'failed',
      });

      throw error;
    }
  }

  /**
   * Persists the event, deduplicating on the provider's event id.
   *
   * Runs as system: at this point no tenant is known, and the row is deliberately
   * written unattributed rather than discarded.
   */
  private async record(
    rawPayload: unknown,
    signature: string | undefined,
    event: NormalisedWebhookEvent,
    providerName: BankAccountProvider,
  ): Promise<{ id: string; alreadyProcessed: boolean }> {
    return RequestContext.runAsSystem({}, async () => {
      if (event.providerEventId) {
        const existing = await this.prisma.webhookEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider: providerName,
              providerEventId: event.providerEventId,
            },
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
      }

      const created = await this.prisma.webhookEvent.create({
        data: {
          provider: providerName,
          eventType: event.rawEventType,
          providerEventId: event.providerEventId,
          payload: rawPayload as never,
          signature: signature?.slice(0, 512),
          status: WebhookEventStatus.RECEIVED,
        },
        select: { id: true },
      });

      return { id: created.id, alreadyProcessed: false };
    });
  }

  private async apply(
    eventId: string,
    event: NormalisedWebhookEvent,
  ): Promise<{
    status: WebhookEventStatus;
    tenantId?: string;
    ledgerEntryId?: string;
    duplicate?: boolean;
  }> {
    switch (event.kind) {
      case WebhookEventKind.FundingReceived:
        return this.applyFunding(eventId, event);

      case WebhookEventKind.AccountAssigned:
        return this.applyAccountAssignment(event);

      case WebhookEventKind.AccountAssignmentFailed:
        this.logger.error(
          { eventId, userId: event.accountAssignment?.userId },
          'Provider failed to assign a dedicated account; customer cannot be funded',
        );
        return { status: WebhookEventStatus.PROCESSED };

      case WebhookEventKind.Ignored:
      default:
        return { status: WebhookEventStatus.IGNORED };
    }
  }

  /** Credits the wallet behind the destination account. */
  private async applyFunding(
    eventId: string,
    event: NormalisedWebhookEvent,
  ): Promise<{
    status: WebhookEventStatus;
    tenantId?: string;
    ledgerEntryId?: string;
    duplicate: boolean;
  }> {
    const transfer = event.transfer;
    if (!transfer) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Funding event carried no transfer details',
      });
    }

    // Single-use accounts are checked first. They are the narrower match — one
    // account, one order, one payment — and resolving a wallet top-up against an
    // on-ramp payment would credit naira to a customer who is owed crypto.
    const onramp = await this.onramp.findForCredit({
      reference: transfer.destinationAccountReference,
      accountNumber: transfer.destinationAccountNumber,
    });

    if (onramp) {
      const settled = await this.onramp.settle(onramp.id, {
        reference: transfer.reference,
        amount: transfer.amount,
        paidAt: transfer.paidAt,
      });

      this.logger.info(
        {
          eventId,
          orderRef: settled.account.orderRef,
          duplicate: settled.duplicate,
          underpaid: settled.underpaid,
        },
        'Inbound transfer matched a single-use on-ramp account',
      );

      return {
        status: WebhookEventStatus.PROCESSED,
        tenantId: settled.account.tenantId ?? undefined,
        duplicate: settled.duplicate,
      };
    }

    const owner = await this.resolveOwner(transfer);

    // Re-enter a normal tenant-scoped context: from here on, every query is
    // subject to the usual isolation guarantees.
    return RequestContext.run(
      {
        tenantId: owner.tenantId,
        actorType: ActorType.Webhook,
        correlationId: RequestContext.correlationId,
      },
      async () => {
        const result = await this.wallet.credit({
          userId: owner.userId,
          amount: transfer.amount,
          type: LedgerEntryType.TOPUP,
          // The provider's reference is the idempotency key. Their retries carry
          // the same value, so a redelivery resolves to the existing entry.
          reference: transfer.reference,
          providerReference: transfer.reference,
          narration: transfer.senderName ? `Transfer from ${transfer.senderName}` : 'Bank transfer',
          metadata: {
            webhookEventId: eventId,
            senderName: transfer.senderName ?? null,
            senderBank: transfer.senderBank ?? null,
            paidAt: transfer.paidAt?.toISOString() ?? null,
          },
        });

        this.logger.info(
          {
            userId: owner.userId,
            amount: transfer.amount.toDecimalString(),
            reference: transfer.reference,
            duplicate: result.duplicate,
          },
          'Wallet funded from inbound transfer',
        );

        return {
          status: WebhookEventStatus.PROCESSED,
          tenantId: owner.tenantId,
          ledgerEntryId: result.entryId,
          duplicate: result.duplicate,
        };
      },
    );
  }

  /**
   * Finds which customer an inbound transfer belongs to.
   *
   * Unscoped by necessity — the tenant is precisely what we are trying to
   * discover — so this is one of the few queries that runs outside tenant
   * isolation, and it looks up an immutable, provider-issued identifier rather
   * than anything a caller controls.
   */
  private async resolveOwner(transfer: {
    destinationAccountNumber?: string;
    destinationAccountReference?: string;
  }): Promise<{ userId: string; tenantId: string }> {
    const account = await RequestContext.runAsSystem({}, async () =>
      this.prisma.bankAccount.findFirst({
        where: {
          deletedAt: null,
          ...(transfer.destinationAccountReference
            ? { reference: transfer.destinationAccountReference }
            : { accountNumber: transfer.destinationAccountNumber ?? '__none__' }),
        },
        select: { userId: true, tenantId: true },
      }),
    );

    if (!account) {
      // Money arrived at an account we do not recognise. This must be loud: it is
      // either a provisioning bug or funds sitting unattributed in a settlement
      // account, and both need a human.
      this.logger.error(
        {
          accountNumber: transfer.destinationAccountNumber,
          reference: transfer.destinationAccountReference,
        },
        'Inbound transfer for an unknown destination account',
      );

      throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
        message: 'No wallet is associated with the destination account',
      });
    }

    return account;
  }

  /** Records a newly issued virtual account against its owner. */
  private async applyAccountAssignment(
    event: NormalisedWebhookEvent,
  ): Promise<{ status: WebhookEventStatus; tenantId?: string }> {
    const assignment = event.accountAssignment;
    if (!assignment?.account || !assignment.userId) {
      return { status: WebhookEventStatus.IGNORED };
    }

    const user = await RequestContext.runAsSystem({}, async () =>
      this.prisma.user.findFirst({
        where: { id: assignment.userId, deletedAt: null },
        select: { id: true, tenantId: true },
      }),
    );

    if (!user) {
      this.logger.warn(
        { userId: assignment.userId },
        'Account assignment for an unknown user; ignoring',
      );
      return { status: WebhookEventStatus.IGNORED };
    }

    await RequestContext.run(
      { tenantId: user.tenantId, actorType: ActorType.Webhook },
      async () => {
        const account = assignment.account;

        // Upsert: the account may already exist if provisioning succeeded
        // synchronously and the webhook is confirming it.
        await this.db.bankAccount.upsert({
          where: { userId: user.id },
          create: {
            tenantId: user.tenantId,
            userId: user.id,
            provider: account.provider,
            reference: account.reference,
            bankName: account.bankName,
            bankCode: account.bankCode,
            accountName: account.accountName,
            accountNumber: account.accountNumber,
            currency: account.currency,
            metadata: account.raw as never,
          },
          update: {
            reference: account.reference,
            bankName: account.bankName,
            bankCode: account.bankCode,
            accountName: account.accountName,
            accountNumber: account.accountNumber,
            isActive: true,
          },
        });
      },
    );

    this.logger.info({ userId: user.id }, 'Dedicated funding account recorded');
    return { status: WebhookEventStatus.PROCESSED, tenantId: user.tenantId };
  }
}
