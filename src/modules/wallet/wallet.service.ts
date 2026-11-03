import { Injectable } from '@nestjs/common';
import {
  LedgerDirection,
  LedgerEntryStatus,
  LedgerEntryType,
  Prisma,
  WalletStatus,
} from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import { InjectPrisma } from '../../infrastructure/database/prisma.module';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

export interface MovementParams {
  /** Wallet owner. Resolved to a wallet inside the locking transaction. */
  userId: string;
  amount: Money;
  type: LedgerEntryType;
  /**
   * Idempotency key, unique per tenant.
   *
   * For provider-driven credits this is the provider's transaction reference —
   * the value that is stable across their retries.
   */
  reference: string;
  narration?: string;
  providerReference?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface MovementResult {
  entryId: string;
  balanceBefore: Money;
  balanceAfter: Money;
  /**
   * True when this reference had already been applied and nothing changed.
   * Callers should treat it as success — it is the idempotent path, not an error.
   */
  duplicate: boolean;
}

/**
 * The transactional client handed to a `$transaction` callback.
 *
 * Derived from the extended client rather than written as
 * `Prisma.TransactionClient`: the tenant and soft-delete extensions change the
 * client's type, and the un-extended alias is not assignable to it.
 */
type WalletTransactionClient = Parameters<Parameters<ExtendedPrismaClient['$transaction']>[0]>[0];

/** Shape returned by the `FOR UPDATE` lock query. */
interface LockedWallet {
  id: string;
  balance: bigint;
  lockedBalance: bigint;
  currency: string;
  status: WalletStatus;
}

/**
 * All movement of customer funds.
 *
 * ## Concurrency: pessimistic locking, not optimistic
 *
 * Every mutation opens a transaction and takes `SELECT … FOR UPDATE` on the
 * wallet row before reading its balance. Two concurrent debits therefore serialise:
 * the second blocks until the first commits, then reads the updated balance.
 *
 * The alternative — read, compute, then `UPDATE … WHERE version = n` — is a
 * *retry* strategy, and under the contention this table sees (a webhook and a
 * customer action landing together) it converts lost updates into a retry storm.
 * For money, blocking briefly is strictly better than racing. Contention is per
 * user, so the lock is never hot: two customers never wait on each other.
 *
 * ## Idempotency has three layers
 *
 * 1. The `FOR UPDATE` lock serialises duplicate deliveries of the same event.
 * 2. Inside the lock, an existing entry with the same `reference` short-circuits.
 * 3. `@@unique([tenantId, reference])` is the backstop that makes a double credit
 *    impossible even if 1 and 2 were both wrong.
 *
 * Layer 3 is what actually guarantees correctness; 1 and 2 make the common case
 * fast and the error path clean.
 *
 * ## Why the lock query is raw SQL
 *
 * Prisma has no `FOR UPDATE`. That means the tenant extension does **not** apply,
 * so `tenantId` is bound explicitly in the predicate below. This is the documented
 * escape hatch from the isolation model, and it is the single most important place
 * in the codebase to get that filter right.
 */
@Injectable()
export class WalletService {
  constructor(
    @InjectPrisma() private readonly db: ExtendedPrismaClient,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(WalletService.name);
  }

  /** Adds funds. Used by funding webhooks, refunds and reversals. */
  async credit(params: MovementParams): Promise<MovementResult> {
    return this.move(params, LedgerDirection.CREDIT);
  }

  /**
   * Removes funds.
   *
   * @throws AppException(INSUFFICIENT_BALANCE) when available funds are short.
   *         Checked inside the lock, so the answer cannot be stale.
   */
  async debit(params: MovementParams): Promise<MovementResult> {
    return this.move(params, LedgerDirection.DEBIT);
  }

  // ===========================================================================
  //  Two-phase movements: hold → settle | release
  // ===========================================================================
  //
  // An outward transfer is not instantaneous. Between "the customer asked" and
  // "the recipient's bank confirmed" there is a window of seconds to minutes in
  // which the money must be neither spendable nor gone.
  //
  // A single-phase `debit` at request time gets this wrong in both directions:
  // if the transfer fails we have taken money for a payment that never happened
  // and must invent a compensating credit, and if the *process* dies between the
  // debit and the provider call the customer is short with nothing to show for
  // it. Deferring the debit until the webhook is worse still — the balance stays
  // spendable, so a customer can withdraw the same ₦50,000 five times before the
  // first confirmation lands.
  //
  // So: `hold` reserves against `lockedBalance` without touching `balance`,
  // making the funds unspendable but still owned. Exactly one of `settle` (the
  // money left) or `release` (it did not) closes the hold.

  /**
   * Reserves funds for an in-flight transaction without moving them.
   *
   * Writes a PENDING entry whose `balanceBefore` and `balanceAfter` are equal —
   * a hold is a claim on the balance, not a change to it, and recording a
   * movement that has not happened would corrupt the self-verifying chain.
   *
   * @throws AppException(INSUFFICIENT_BALANCE) when available funds are short.
   */
  async hold(params: MovementParams): Promise<MovementResult> {
    const tenantId = RequestContext.requireTenantId();

    if (!params.amount.isPositive()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Transaction amount must be greater than zero',
        details: { amount: params.amount.toDecimalString() },
      });
    }

    return this.db.$transaction(
      async (tx) => {
        const wallet = await this.lock(tx, params.userId, tenantId);
        this.assertUsable(wallet, LedgerDirection.DEBIT);

        const existing = await tx.walletLedgerEntry.findFirst({
          where: { reference: params.reference },
          select: { id: true, balanceBefore: true, balanceAfter: true, currency: true },
        });

        if (existing) {
          // A resubmitted withdrawal form. The first hold stands; a second
          // reservation of the same funds is exactly what must not happen.
          this.logger.info(
            { reference: params.reference, entryId: existing.id, userId: params.userId },
            'Hold already exists for this reference; treating as idempotent replay',
          );
          return {
            entryId: existing.id,
            balanceBefore: Money.fromKobo(existing.balanceBefore, existing.currency),
            balanceAfter: Money.fromKobo(existing.balanceAfter, existing.currency),
            duplicate: true,
          } satisfies MovementResult;
        }

        const balance = Money.fromKobo(wallet.balance, wallet.currency);

        if (params.amount.currency !== wallet.currency) {
          throw new AppException(ErrorCode.VALIDATION_FAILED, {
            message: 'Transaction currency does not match the wallet',
            details: { wallet: wallet.currency, transaction: params.amount.currency },
          });
        }

        // Available excludes existing holds, so two concurrent withdrawals
        // cannot both reserve the same naira — the second sees the first's
        // reservation because it waited on the row lock.
        const available = balance.subtract(Money.fromKobo(wallet.lockedBalance, wallet.currency));

        if (available.lessThan(params.amount)) {
          throw new AppException(ErrorCode.INSUFFICIENT_BALANCE, {
            message: 'Insufficient balance for this transaction',
            details: {
              available: available.toDecimalString(),
              required: params.amount.toDecimalString(),
              currency: wallet.currency,
            },
          });
        }

        const entry = await tx.walletLedgerEntry.create({
          data: {
            tenantId,
            walletId: wallet.id,
            userId: params.userId,
            direction: LedgerDirection.DEBIT,
            type: params.type,
            status: LedgerEntryStatus.PENDING,
            amount: params.amount.kobo,
            currency: wallet.currency,
            // Equal, deliberately: see the method comment.
            balanceBefore: balance.kobo,
            balanceAfter: balance.kobo,
            reference: params.reference,
            providerReference: params.providerReference,
            narration: params.narration,
            metadata: params.metadata,
          },
          select: { id: true },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            lockedBalance: { increment: params.amount.kobo },
            version: { increment: 1 },
          },
        });

        this.logger.info(
          {
            userId: params.userId,
            entryId: entry.id,
            amount: params.amount.toDecimalString(),
            reference: params.reference,
          },
          'Funds held for an in-flight transaction',
        );

        return {
          entryId: entry.id,
          balanceBefore: balance,
          balanceAfter: balance,
          duplicate: false,
        } satisfies MovementResult;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }

  /**
   * Converts a hold into a completed debit. The money has left.
   *
   * `balanceBefore`/`balanceAfter` are recomputed here rather than reused from
   * the hold: credits may have landed in between, so the values captured at hold
   * time are stale, and writing them would break the property that each entry's
   * `balanceBefore` matches the previous entry's `balanceAfter`. This is the
   * moment the movement actually occurs, so this is when it is recorded.
   */
  async settle(reference: string): Promise<MovementResult> {
    return this.closeHold(reference, LedgerEntryStatus.COMPLETED);
  }

  /**
   * Releases a hold without moving money. The transaction did not happen.
   *
   * The entry is marked FAILED rather than deleted: "we tried to send ₦50,000
   * and the bank rejected it" is exactly the kind of thing a customer disputes,
   * and a deleted row cannot answer them.
   */
  async release(reference: string, reason?: string): Promise<MovementResult> {
    return this.closeHold(reference, LedgerEntryStatus.FAILED, reason);
  }

  /**
   * The shared close-out path for {@link settle} and {@link release}.
   *
   * Both are idempotent on the terminal state — a webhook redelivered after the
   * payout completed must not debit twice, and one redelivered after a release
   * must not credit funds back that were never taken.
   */
  private async closeHold(
    reference: string,
    outcome: typeof LedgerEntryStatus.COMPLETED | typeof LedgerEntryStatus.FAILED,
    reason?: string,
  ): Promise<MovementResult> {
    const tenantId = RequestContext.requireTenantId();

    return this.db.$transaction(
      async (tx) => {
        // The entry is found first, but *outside* any balance read: the wallet
        // row must be locked before its balance is used for anything.
        const held = await tx.walletLedgerEntry.findFirst({
          where: { reference },
          select: {
            id: true,
            userId: true,
            walletId: true,
            amount: true,
            currency: true,
            status: true,
            balanceBefore: true,
            balanceAfter: true,
            metadata: true,
          },
        });

        if (!held) {
          throw new AppException(ErrorCode.RESOURCE_NOT_FOUND, {
            message: 'No held transaction exists for this reference',
            details: { reference },
          });
        }

        if (held.status !== LedgerEntryStatus.PENDING) {
          // Already closed. Return what happened rather than raising: the caller
          // is a webhook handler, and a redelivery is normal traffic.
          if (held.status !== outcome) {
            // Closed the *other* way. This is a genuine conflict — a payout that
            // both completed and failed — and silently ignoring it would leave a
            // customer's balance disagreeing with the provider's records.
            this.logger.error(
              { reference, entryId: held.id, recorded: held.status, attempted: outcome },
              'Hold was already closed with a different outcome',
            );
            throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, {
              message: 'This transaction has already been closed with a different outcome',
              details: { reference, recorded: held.status, attempted: outcome },
            });
          }

          return {
            entryId: held.id,
            balanceBefore: Money.fromKobo(held.balanceBefore, held.currency),
            balanceAfter: Money.fromKobo(held.balanceAfter, held.currency),
            duplicate: true,
          } satisfies MovementResult;
        }

        const wallet = await this.lock(tx, held.userId, tenantId);

        const amount = Money.fromKobo(held.amount, held.currency);
        const before = Money.fromKobo(wallet.balance, wallet.currency);
        const after = outcome === LedgerEntryStatus.COMPLETED ? before.subtract(amount) : before;

        // A hold can only be released once, so `lockedBalance` should never go
        // negative. If it would, the reservation was lost or double-released and
        // the arithmetic below is no longer trustworthy — stop rather than
        // clamp, because a silently clamped lock understates what is spendable.
        if (wallet.lockedBalance < held.amount) {
          this.logger.error(
            {
              reference,
              entryId: held.id,
              locked: String(wallet.lockedBalance),
              held: String(held.amount),
            },
            'Locked balance is less than the hold being closed',
          );
          throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, {
            message: 'Wallet hold accounting is inconsistent; manual review required',
            details: { reference },
          });
        }

        await tx.walletLedgerEntry.update({
          where: { id: held.id },
          data: {
            status: outcome,
            balanceBefore: before.kobo,
            balanceAfter: after.kobo,
            ...(reason
              ? {
                  metadata: {
                    ...((held.metadata as Record<string, unknown> | null) ?? {}),
                    failureReason: reason.slice(0, 512),
                  },
                }
              : {}),
          },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            lockedBalance: { decrement: held.amount },
            ...(outcome === LedgerEntryStatus.COMPLETED
              ? {
                  balance: after.kobo,
                  totalDebited: { increment: held.amount },
                  lastTransactionAt: new Date(),
                }
              : {}),
            version: { increment: 1 },
          },
        });

        this.logger.info(
          {
            userId: held.userId,
            entryId: held.id,
            reference,
            outcome,
            amount: amount.toDecimalString(),
            balanceAfter: after.toDecimalString(),
          },
          outcome === LedgerEntryStatus.COMPLETED
            ? 'Hold settled; funds debited'
            : 'Hold released; funds returned to the spendable balance',
        );

        return {
          entryId: held.id,
          balanceBefore: before,
          balanceAfter: after,
          duplicate: false,
        } satisfies MovementResult;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }

  /** The customer's current balance. */
  async getBalance(userId: string): Promise<{
    balance: Money;
    available: Money;
    locked: Money;
    status: WalletStatus;
    currency: string;
  }> {
    const wallet = await this.db.wallet.findFirst({
      where: { userId },
      select: {
        balance: true,
        lockedBalance: true,
        currency: true,
        status: true,
      },
    });

    if (!wallet) throw AppException.notFound('Wallet');

    return {
      balance: Money.fromKobo(wallet.balance, wallet.currency),
      available: Money.fromKobo(wallet.balance - wallet.lockedBalance, wallet.currency),
      locked: Money.fromKobo(wallet.lockedBalance, wallet.currency),
      status: wallet.status,
      currency: wallet.currency,
    };
  }

  /**
   * The shared implementation behind {@link credit} and {@link debit}.
   *
   * Kept as one method because the two differ only in a sign and one balance
   * check; duplicating the transaction and locking logic is how the two paths
   * would drift apart and only one of them would get the next bug fix.
   */
  private async move(params: MovementParams, direction: LedgerDirection): Promise<MovementResult> {
    const tenantId = RequestContext.requireTenantId();

    if (!params.amount.isPositive()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        message: 'Transaction amount must be greater than zero',
        details: { amount: params.amount.toDecimalString() },
      });
    }

    const started = Date.now();

    const result = await this.db.$transaction(
      async (tx) => {
        // ---------------------------------------------------------------------
        // 1. Lock the wallet row.
        //
        // `tenantId` is bound by hand: raw SQL bypasses the tenant extension, so
        // omitting it here would let a caller with a foreign userId move another
        // tenant's money. Parameters are bound, never interpolated.
        // ---------------------------------------------------------------------
        const wallet = await this.lock(tx, params.userId, tenantId);

        this.assertUsable(wallet, direction);

        // ---------------------------------------------------------------------
        // 2. Idempotency — has this reference already been applied?
        //
        // Safe to read *after* taking the lock: a concurrent duplicate is still
        // waiting on the same row, so by the time it gets here the first entry
        // is committed and visible.
        // ---------------------------------------------------------------------
        const existing = await tx.walletLedgerEntry.findFirst({
          where: { reference: params.reference },
          select: { id: true, balanceBefore: true, balanceAfter: true, currency: true },
        });

        if (existing) {
          this.logger.info(
            { reference: params.reference, entryId: existing.id, userId: params.userId },
            'Ledger entry already exists for this reference; treating as idempotent replay',
          );
          return {
            entryId: existing.id,
            balanceBefore: Money.fromKobo(existing.balanceBefore, existing.currency),
            balanceAfter: Money.fromKobo(existing.balanceAfter, existing.currency),
            duplicate: true,
          } satisfies MovementResult;
        }

        // ---------------------------------------------------------------------
        // 3. Compute the new balance.
        // ---------------------------------------------------------------------
        const before = Money.fromKobo(wallet.balance, wallet.currency);
        const amount = params.amount;

        if (amount.currency !== wallet.currency) {
          throw new AppException(ErrorCode.VALIDATION_FAILED, {
            message: 'Transaction currency does not match the wallet',
            details: { wallet: wallet.currency, transaction: amount.currency },
          });
        }

        const after =
          direction === LedgerDirection.CREDIT ? before.add(amount) : before.subtract(amount);

        if (direction === LedgerDirection.DEBIT) {
          // Available funds exclude anything already held by a pending
          // transaction, so a customer cannot spend the same naira twice.
          const available = before.subtract(Money.fromKobo(wallet.lockedBalance, wallet.currency));

          if (available.lessThan(amount)) {
            throw new AppException(ErrorCode.INSUFFICIENT_BALANCE, {
              message: 'Insufficient balance for this transaction',
              details: {
                available: available.toDecimalString(),
                required: amount.toDecimalString(),
                currency: wallet.currency,
              },
            });
          }
        }

        // ---------------------------------------------------------------------
        // 4. Write the ledger entry, then update the cached balance.
        //
        // Order matters for debuggability: if the update failed, an orphan entry
        // would be visible and detectable. The reverse would silently move money
        // with no record of why.
        // ---------------------------------------------------------------------
        const entry = await tx.walletLedgerEntry.create({
          data: {
            tenantId,
            walletId: wallet.id,
            userId: params.userId,
            direction,
            type: params.type,
            status: LedgerEntryStatus.COMPLETED,
            amount: amount.kobo,
            currency: wallet.currency,
            balanceBefore: before.kobo,
            balanceAfter: after.kobo,
            reference: params.reference,
            providerReference: params.providerReference,
            narration: params.narration,
            metadata: params.metadata,
          },
          select: { id: true },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: after.kobo,
            ...(direction === LedgerDirection.CREDIT
              ? { totalCredited: { increment: amount.kobo } }
              : { totalDebited: { increment: amount.kobo } }),
            lastTransactionAt: new Date(),
            version: { increment: 1 },
          },
        });

        return {
          entryId: entry.id,
          balanceBefore: before,
          balanceAfter: after,
          duplicate: false,
        } satisfies MovementResult;
      },
      {
        // Short and explicit. A wallet transaction that cannot finish in 10s is
        // wedged, and holding the row lock any longer blocks the customer's own
        // subsequent requests.
        timeout: 10_000,
        maxWait: 5_000,
      },
    );

    this.metrics.dbQueryDuration.observe(
      { model: 'Wallet', operation: direction.toLowerCase() },
      (Date.now() - started) / 1000,
    );

    if (!result.duplicate) {
      this.logger.info(
        {
          userId: params.userId,
          entryId: result.entryId,
          direction,
          type: params.type,
          amount: params.amount.toDecimalString(),
          balanceAfter: result.balanceAfter.toDecimalString(),
          reference: params.reference,
        },
        'Wallet movement applied',
      );
    }

    return result;
  }

  /**
   * Takes `SELECT … FOR UPDATE` on the wallet row.
   *
   * `tenantId` is bound by hand: raw SQL bypasses the tenant extension, so
   * omitting it here would let a caller with a foreign userId move another
   * tenant's money. Parameters are bound, never interpolated.
   *
   * Every balance-mutating path goes through this one query, so the isolation
   * predicate exists in exactly one place to get right.
   */
  private async lock(
    tx: WalletTransactionClient,
    userId: string,
    tenantId: string,
  ): Promise<LockedWallet> {
    const rows = await tx.$queryRaw<LockedWallet[]>`
      SELECT id, balance, "lockedBalance", currency, status
      FROM wallets
      WHERE "userId" = ${userId}::uuid
        AND "tenantId" = ${tenantId}::uuid
        AND "deletedAt" IS NULL
      FOR UPDATE
    `;

    const wallet = rows[0];
    if (!wallet) throw AppException.notFound('Wallet');

    return wallet;
  }

  private assertUsable(wallet: LockedWallet, direction: LedgerDirection): void {
    if (wallet.status === WalletStatus.ACTIVE) return;

    // A frozen wallet still accepts credits: blocking an inbound transfer would
    // mean money leaves the customer's bank and lands nowhere. Debits stop.
    if (wallet.status === WalletStatus.FROZEN && direction === LedgerDirection.CREDIT) {
      return;
    }

    throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, {
      message:
        wallet.status === WalletStatus.FROZEN
          ? 'This wallet is frozen and cannot be debited'
          : 'This wallet is not active',
      details: { status: wallet.status },
    });
  }
}
