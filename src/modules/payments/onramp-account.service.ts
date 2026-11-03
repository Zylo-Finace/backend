import { Inject, Injectable } from '@nestjs/common';
import { OnrampAccountStatus, type OnrampVirtualAccount } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import {
  DYNAMIC_ACCOUNT_PROVIDER,
  type DynamicAccountProvider,
} from './payment-provider.interface';

export interface IssueOnrampAccountInput {
  /** Our on-ramp order reference. One account per order. */
  orderRef: string;
  /** Exactly what the customer must transfer. */
  amount: Money;
  /** Payer identity. At least one of `userId` / `phoneE164` is required. */
  userId?: string;
  tenantId?: string;
  phoneE164?: string;
  /** Name displayed to the payer. Not identity-checked. */
  fullName: string;
  email?: string;
}

/** What the customer is shown. */
export interface OnrampAccountDetails {
  reference: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  amount: Money;
  expiresAt: Date;
}

/**
 * Single-use accounts for the naira → crypto on-ramp.
 *
 * ## Why on-ramp payments do not use the wallet funding account
 *
 * A funding account is permanent and reusable, which is exactly wrong here. An
 * on-ramp payment is a quote: "send ₦150,000 in the next 30 minutes and receive
 * 92.4 USDC". A permanent account cannot express the deadline, cannot tell a
 * second transfer apart from the first, and cannot be shown to a customer who
 * has not completed KYC — which is most of them, since the on-ramp is the first
 * thing a new customer touches.
 *
 * A dynamic account solves all three: it is bound to one order, it expires with
 * the quote, and the partner bank issues it without a BVN.
 *
 * ## The expiry is a real deadline
 *
 * PayVessel refunds money sent to a spent or expired dynamic account. That is a
 * good default — nobody's naira disappears — but it means an account advertised
 * past its expiry collects nothing while appearing to work, and the customer
 * discovers this days later when the reversal lands. Our TTL is therefore set
 * shorter than the provider's, and {@link expireStale} sweeps anything that
 * outlives it.
 *
 * ## Why the unscoped client
 *
 * Every query here uses the raw `PrismaService` inside `runAsSystem`, never the
 * tenant-scoped `ExtendedPrismaClient`. `OnrampVirtualAccount` declares a
 * `tenantId`, so the scope extension registers it automatically — and would then
 * filter out precisely the rows we need, because an account issued to a WhatsApp
 * number before any `User` exists has `tenantId` null. The webhook path has no
 * tenant either: finding the owner is the whole point of the lookup. Switching a
 * query here to `this.db` would silently stop matching payments.
 */
@Injectable()
export class OnrampAccountService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DYNAMIC_ACCOUNT_PROVIDER) private readonly provider: DynamicAccountProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OnrampAccountService.name);
  }

  /**
   * Issues the account a customer pays into for one order.
   *
   * Idempotent on `orderRef`: a customer who taps "pay" twice, or a retried
   * request, gets the same account back rather than a second live NUBAN nobody
   * is reconciling.
   */
  async issue(input: IssueOnrampAccountInput): Promise<OnrampAccountDetails> {
    if (!input.userId && !input.phoneE164) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'An on-ramp account needs either a user id or a phone number',
      });
    }
    if (!input.amount.isPositive()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'An on-ramp account needs a positive expected amount',
      });
    }

    const existing = await this.findLive(input.orderRef);
    if (existing) return toDetails(existing);

    const account = await this.provider.createDynamicAccount({
      orderRef: input.orderRef,
      fullName: input.fullName,
      // Providers require an email. A deterministic placeholder derived from the
      // phone keeps issuance possible for customers who gave none, and stays
      // stable so a retry maps to the same provider customer.
      email:
        input.email ??
        `${(input.phoneE164 ?? input.orderRef).replace(/\D/g, '')}@customers.invalid`,
      phoneE164: input.phoneE164 ?? '',
    });

    // Ours, not theirs. Taking the shorter of the two means we stop advertising
    // the account before the provider starts refunding senders.
    const ours = new Date(
      Date.now() + this.config.payments.payvessel.dynamicAccountTtlMinutes * 60_000,
    );
    const expiresAt = account.expiresAt && account.expiresAt < ours ? account.expiresAt : ours;

    const created = await RequestContext.runAsSystem({}, async () =>
      this.prisma.onrampVirtualAccount.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          phoneE164: input.phoneE164,
          provider: account.provider,
          reference: account.reference,
          bankName: account.bankName,
          bankCode: account.bankCode,
          accountName: account.accountName,
          accountNumber: account.accountNumber,
          currency: account.currency,
          expectedAmountKobo: input.amount.kobo,
          orderRef: input.orderRef,
          expiresAt,
          metadata: account.raw as never,
        },
      }),
    );

    this.logger.info(
      { orderRef: input.orderRef, bank: account.bankName, expiresAt },
      'Issued a single-use on-ramp account',
    );

    return toDetails(created);
  }

  /**
   * Finds the on-ramp account a credit belongs to, if any.
   *
   * Tried by the provider's tracking reference first — it is unique and
   * unambiguous. The NUBAN is the fallback, and it is matched only against
   * accounts still awaiting payment, because providers recycle dynamic numbers
   * and an expired issuance must not absorb a later customer's money.
   */
  async findForCredit(match: {
    reference?: string;
    accountNumber?: string;
  }): Promise<OnrampVirtualAccount | null> {
    return RequestContext.runAsSystem({}, async () => {
      if (match.reference) {
        const byReference = await this.prisma.onrampVirtualAccount.findFirst({
          where: { reference: match.reference },
        });
        if (byReference) return byReference;
      }

      if (!match.accountNumber) return null;

      return this.prisma.onrampVirtualAccount.findFirst({
        where: {
          accountNumber: match.accountNumber,
          status: OnrampAccountStatus.AWAITING_PAYMENT,
        },
        orderBy: { createdAt: 'desc' },
      });
    });
  }

  /**
   * Records that money arrived against an on-ramp account.
   *
   * Returns `duplicate: true` for a redelivery so the caller acknowledges
   * without acting twice. Deliberately does **not** dispatch the crypto leg: the
   * money is recorded first and fulfilment reads from this state, so a crash
   * between the two loses nothing that cannot be replayed.
   */
  async settle(
    accountId: string,
    payment: { reference: string; amount: Money; paidAt?: Date },
  ): Promise<{ account: OnrampVirtualAccount; duplicate: boolean; underpaid: boolean }> {
    return RequestContext.runAsSystem({}, async () => {
      const current = await this.prisma.onrampVirtualAccount.findUniqueOrThrow({
        where: { id: accountId },
      });

      if (current.status !== OnrampAccountStatus.AWAITING_PAYMENT) {
        return { account: current, duplicate: true, underpaid: false };
      }

      const paid = payment.amount.kobo;
      const underpaid = paid < current.expectedAmountKobo;

      const account = await this.prisma.onrampVirtualAccount.update({
        where: { id: accountId },
        data: {
          status: OnrampAccountStatus.PAID,
          paidAmountKobo: paid,
          paymentReference: payment.reference,
          paidAt: payment.paidAt ?? new Date(),
        },
      });

      if (underpaid) {
        // Not an error — the customer's transfer is real money that arrived. It
        // is a state that needs a decision (fulfil less, or refund), so it is
        // recorded loudly rather than fulfilled at the quoted rate.
        this.logger.warn(
          {
            orderRef: account.orderRef,
            expected: Money.fromKobo(current.expectedAmountKobo).toDecimalString(),
            received: payment.amount.toDecimalString(),
          },
          'On-ramp account underpaid; fulfilment needs review',
        );
      } else {
        this.logger.info(
          { orderRef: account.orderRef, amount: payment.amount.toDecimalString() },
          'On-ramp account paid',
        );
      }

      return { account, duplicate: false, underpaid };
    });
  }

  /** Marks the crypto leg as delivered. */
  async markFulfilled(accountId: string): Promise<void> {
    await RequestContext.runAsSystem({}, async () =>
      this.prisma.onrampVirtualAccount.update({
        where: { id: accountId },
        data: { status: OnrampAccountStatus.FULFILLED },
      }),
    );
  }

  /**
   * Retires accounts that outlived their quote.
   *
   * Scoped to `AWAITING_PAYMENT` so a payment that landed in the last seconds
   * before expiry is never expired out from under itself.
   */
  async expireStale(): Promise<number> {
    const result = await RequestContext.runAsSystem({}, async () =>
      this.prisma.onrampVirtualAccount.updateMany({
        where: { status: OnrampAccountStatus.AWAITING_PAYMENT, expiresAt: { lt: new Date() } },
        data: { status: OnrampAccountStatus.EXPIRED },
      }),
    );

    if (result.count > 0) {
      this.logger.info({ count: result.count }, 'Expired unpaid on-ramp accounts');
    }
    return result.count;
  }

  /** The live account for an order, if one is still worth showing. */
  private async findLive(orderRef: string): Promise<OnrampVirtualAccount | null> {
    return RequestContext.runAsSystem({}, async () =>
      this.prisma.onrampVirtualAccount.findFirst({
        where: {
          orderRef,
          status: OnrampAccountStatus.AWAITING_PAYMENT,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}

function toDetails(account: OnrampVirtualAccount): OnrampAccountDetails {
  return {
    reference: account.reference,
    bankName: account.bankName,
    accountName: account.accountName,
    accountNumber: account.accountNumber,
    amount: Money.fromKobo(account.expectedAmountKobo, account.currency),
    expiresAt: account.expiresAt,
  };
}
