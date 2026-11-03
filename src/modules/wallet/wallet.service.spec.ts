import { LedgerEntryStatus, LedgerEntryType, WalletStatus } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';

import { RequestContext } from '../../core/context/request-context';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { ExtendedPrismaClient } from '../../infrastructure/database/prisma.service';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import { WalletService } from './wallet.service';

const TENANT_ID = '0195f2a0-0000-7000-8000-000000000001';
const USER_ID = '0195f2a0-0000-7000-8000-000000000002';
const WALLET_ID = '0195f2a0-0000-7000-8000-000000000003';

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const metrics = {
  dbQueryDuration: { observe: jest.fn() },
} as unknown as MetricsService;

/**
 * Builds a Prisma double whose `$transaction` runs the callback against a
 * transaction client, mirroring how the real client behaves.
 */
function buildDb(options: {
  wallet?: Partial<{
    id: string;
    balance: bigint;
    lockedBalance: bigint;
    currency: string;
    status: WalletStatus;
  }> | null;
  existingEntry?: {
    id: string;
    balanceBefore: bigint;
    balanceAfter: bigint;
    currency: string;
  } | null;
}) {
  const walletRow =
    options.wallet === null
      ? undefined
      : {
          id: WALLET_ID,
          balance: 0n,
          lockedBalance: 0n,
          currency: 'NGN',
          status: WalletStatus.ACTIVE,
          ...options.wallet,
        };

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(walletRow ? [walletRow] : []),
    walletLedgerEntry: {
      findFirst: jest.fn().mockResolvedValue(options.existingEntry ?? null),
      create: jest.fn().mockResolvedValue({ id: 'entry-1' }),
    },
    wallet: { update: jest.fn().mockResolvedValue({}) },
  };

  const db = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    wallet: { findFirst: jest.fn().mockResolvedValue(walletRow ?? null) },
  } as unknown as ExtendedPrismaClient;

  return { db, tx };
}

const inTenant = <T>(fn: () => Promise<T>) => RequestContext.run({ tenantId: TENANT_ID }, fn);

describe('WalletService', () => {
  describe('credit', () => {
    it('adds funds and records the resulting balance', async () => {
      const { db, tx } = buildDb({ wallet: { balance: 50_000n } });
      const service = new WalletService(db, logger, metrics);

      const result = await inTenant(() =>
        service.credit({
          userId: USER_ID,
          amount: Money.fromNaira('1500.50'),
          type: LedgerEntryType.TOPUP,
          reference: 'TRF_abc',
        }),
      );

      expect(result.balanceBefore.toDecimalString()).toBe('500.00');
      expect(result.balanceAfter.toDecimalString()).toBe('2000.50');
      expect(result.duplicate).toBe(false);

      expect(tx.walletLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            direction: 'CREDIT',
            amount: 150_050n,
            balanceBefore: 50_000n,
            balanceAfter: 200_050n,
            reference: 'TRF_abc',
          }) as unknown,
        }),
      );
    });

    it('locks the wallet row before reading its balance', async () => {
      const { db, tx } = buildDb({ wallet: { balance: 0n } });
      const service = new WalletService(db, logger, metrics);

      await inTenant(() =>
        service.credit({
          userId: USER_ID,
          amount: Money.fromNaira('100'),
          type: LedgerEntryType.TOPUP,
          reference: 'TRF_lock',
        }),
      );

      // Two concurrent credits must serialise, or both read the same starting
      // balance and one update is lost.
      // A tagged template passes the TemplateStringsArray as the first argument
      // and the interpolated values as the rest.
      const [fragments] = tx.$queryRaw.mock.calls[0] as [readonly string[]];
      expect(fragments.join('?')).toContain('FOR UPDATE');
    });

    it('binds the tenant in the raw lock query', async () => {
      const { db, tx } = buildDb({ wallet: {} });
      const service = new WalletService(db, logger, metrics);

      await inTenant(() =>
        service.credit({
          userId: USER_ID,
          amount: Money.fromNaira('10'),
          type: LedgerEntryType.TOPUP,
          reference: 'TRF_tenant',
        }),
      );

      // Raw SQL bypasses the tenant extension, so this filter is the *only*
      // thing preventing cross-tenant movement of funds.
      const [fragments, ...values] = tx.$queryRaw.mock.calls[0] as [
        readonly string[],
        ...unknown[],
      ];
      expect(fragments.join('?')).toContain('"tenantId"');
      // Bound as a parameter, never interpolated into the SQL text.
      expect(values).toContain(TENANT_ID);
    });

    it('refuses to run without a tenant in context', async () => {
      const { db } = buildDb({ wallet: {} });
      const service = new WalletService(db, logger, metrics);

      await expect(
        service.credit({
          userId: USER_ID,
          amount: Money.fromNaira('10'),
          type: LedgerEntryType.TOPUP,
          reference: 'TRF_x',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_RESOLVED });
    });
  });

  describe('idempotency', () => {
    it('returns the existing entry when the reference was already applied', async () => {
      const { db, tx } = buildDb({
        wallet: { balance: 200_050n },
        existingEntry: {
          id: 'entry-original',
          balanceBefore: 50_000n,
          balanceAfter: 200_050n,
          currency: 'NGN',
        },
      });
      const service = new WalletService(db, logger, metrics);

      const result = await inTenant(() =>
        service.credit({
          userId: USER_ID,
          amount: Money.fromNaira('1500.50'),
          type: LedgerEntryType.TOPUP,
          reference: 'TRF_abc',
        }),
      );

      // A redelivered webhook must not credit twice. This is the single most
      // important behaviour in the payments path.
      expect(result.duplicate).toBe(true);
      expect(result.entryId).toBe('entry-original');
      expect(tx.walletLedgerEntry.create).not.toHaveBeenCalled();
      expect(tx.wallet.update).not.toHaveBeenCalled();
    });

    it('checks for the duplicate only after taking the lock', async () => {
      const { db, tx } = buildDb({
        wallet: {},
        existingEntry: {
          id: 'entry-original',
          balanceBefore: 0n,
          balanceAfter: 100n,
          currency: 'NGN',
        },
      });
      const service = new WalletService(db, logger, metrics);

      await inTenant(() =>
        service.credit({
          userId: USER_ID,
          amount: Money.fromNaira('1'),
          type: LedgerEntryType.TOPUP,
          reference: 'TRF_abc',
        }),
      );

      // Ordering is what makes the duplicate check correct under concurrency:
      // a racing duplicate is still blocked on the lock when this read happens.
      const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0]!;
      const checkOrder = tx.walletLedgerEntry.findFirst.mock.invocationCallOrder[0]!;
      expect(lockOrder).toBeLessThan(checkOrder);
    });
  });

  describe('debit', () => {
    it('removes funds when the balance is sufficient', async () => {
      const { db } = buildDb({ wallet: { balance: 200_000n } });
      const service = new WalletService(db, logger, metrics);

      const result = await inTenant(() =>
        service.debit({
          userId: USER_ID,
          amount: Money.fromNaira('500'),
          type: LedgerEntryType.PURCHASE,
          reference: 'PUR_1',
        }),
      );

      expect(result.balanceAfter.toDecimalString()).toBe('1500.00');
    });

    it('refuses to overdraw', async () => {
      const { db, tx } = buildDb({ wallet: { balance: 10_000n } });
      const service = new WalletService(db, logger, metrics);

      await expect(
        inTenant(() =>
          service.debit({
            userId: USER_ID,
            amount: Money.fromNaira('500'),
            type: LedgerEntryType.PURCHASE,
            reference: 'PUR_2',
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_BALANCE });

      expect(tx.walletLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('excludes locked funds from the available balance', async () => {
      // ₦1,000 balance with ₦900 held: only ₦100 is spendable, so a ₦500 debit
      // must fail even though `balance` looks sufficient.
      const { db } = buildDb({ wallet: { balance: 100_000n, lockedBalance: 90_000n } });
      const service = new WalletService(db, logger, metrics);

      await expect(
        inTenant(() =>
          service.debit({
            userId: USER_ID,
            amount: Money.fromNaira('500'),
            type: LedgerEntryType.PURCHASE,
            reference: 'PUR_3',
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_BALANCE });
    });

    it('allows spending exactly the available balance', async () => {
      const { db } = buildDb({ wallet: { balance: 50_000n } });
      const service = new WalletService(db, logger, metrics);

      const result = await inTenant(() =>
        service.debit({
          userId: USER_ID,
          amount: Money.fromNaira('500'),
          type: LedgerEntryType.PURCHASE,
          reference: 'PUR_4',
        }),
      );

      expect(result.balanceAfter.isZero()).toBe(true);
    });
  });

  describe('validation and wallet state', () => {
    it.each([
      ['zero', '0'],
      ['negative', '-100'],
    ])('rejects a %s amount', async (_label, amount) => {
      const { db } = buildDb({ wallet: {} });
      const service = new WalletService(db, logger, metrics);

      await expect(
        inTenant(() =>
          service.credit({
            userId: USER_ID,
            amount: Money.fromNaira(amount),
            type: LedgerEntryType.TOPUP,
            reference: 'TRF_bad',
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    });

    it('reports a missing wallet as not found', async () => {
      const { db } = buildDb({ wallet: null });
      const service = new WalletService(db, logger, metrics);

      await expect(
        inTenant(() =>
          service.credit({
            userId: USER_ID,
            amount: Money.fromNaira('10'),
            type: LedgerEntryType.TOPUP,
            reference: 'TRF_nowallet',
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.RESOURCE_NOT_FOUND });
    });

    it('blocks debits from a frozen wallet', async () => {
      const { db } = buildDb({ wallet: { balance: 100_000n, status: WalletStatus.FROZEN } });
      const service = new WalletService(db, logger, metrics);

      await expect(
        inTenant(() =>
          service.debit({
            userId: USER_ID,
            amount: Money.fromNaira('10'),
            type: LedgerEntryType.PURCHASE,
            reference: 'PUR_frozen',
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION });
    });

    it('still accepts credits into a frozen wallet', async () => {
      // Refusing an inbound transfer would mean money leaves the customer's bank
      // and lands nowhere. Freezing stops spending, not receiving.
      const { db } = buildDb({ wallet: { balance: 0n, status: WalletStatus.FROZEN } });
      const service = new WalletService(db, logger, metrics);

      const result = await inTenant(() =>
        service.credit({
          userId: USER_ID,
          amount: Money.fromNaira('100'),
          type: LedgerEntryType.TOPUP,
          reference: 'TRF_frozen',
        }),
      );

      expect(result.balanceAfter.toDecimalString()).toBe('100.00');
    });

    it('rejects a currency mismatch rather than silently converting', async () => {
      const { db } = buildDb({ wallet: { currency: 'NGN' } });
      const service = new WalletService(db, logger, metrics);

      await expect(
        inTenant(() =>
          service.credit({
            userId: USER_ID,
            amount: Money.fromKobo(1000n, 'GHS'),
            type: LedgerEntryType.TOPUP,
            reference: 'TRF_ghs',
          }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    });
  });

  // ===========================================================================
  //  Two-phase movements
  // ===========================================================================

  describe('hold / settle / release', () => {
    /** A Prisma double that also supports closing out an existing hold. */
    function buildHoldDb(options: {
      balance?: bigint;
      lockedBalance?: bigint;
      heldEntry?: {
        id: string;
        userId: string;
        walletId: string;
        amount: bigint;
        currency: string;
        status: LedgerEntryStatus;
        balanceBefore: bigint;
        balanceAfter: bigint;
        metadata: unknown;
      } | null;
    }) {
      const walletRow = {
        id: WALLET_ID,
        balance: options.balance ?? 100_000n,
        lockedBalance: options.lockedBalance ?? 0n,
        currency: 'NGN',
        status: WalletStatus.ACTIVE,
      };

      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([walletRow]),
        walletLedgerEntry: {
          findFirst: jest.fn().mockResolvedValue(options.heldEntry ?? null),
          create: jest.fn().mockResolvedValue({ id: 'entry-hold' }),
          update: jest.fn().mockResolvedValue({}),
        },
        wallet: { update: jest.fn().mockResolvedValue({}) },
      };

      const db = {
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as ExtendedPrismaClient;

      return { db, tx };
    }

    const heldEntry = (overrides: Partial<{ status: LedgerEntryStatus; amount: bigint }> = {}) => ({
      id: 'entry-hold',
      userId: USER_ID,
      walletId: WALLET_ID,
      amount: 50_000n,
      currency: 'NGN',
      status: LedgerEntryStatus.PENDING,
      balanceBefore: 100_000n,
      balanceAfter: 100_000n,
      metadata: null,
      ...overrides,
    });

    describe('hold', () => {
      it('reserves funds without moving the balance', async () => {
        const { db, tx } = buildHoldDb({ balance: 100_000n });
        const service = new WalletService(db, logger, metrics);

        const result = await inTenant(() =>
          service.hold({
            userId: USER_ID,
            amount: Money.fromNaira('500'),
            type: LedgerEntryType.WITHDRAWAL,
            reference: 'PAY-1',
          }),
        );

        // A hold is a claim on the balance, not a change to it.
        expect(result.balanceBefore.toDecimalString()).toBe('1000.00');
        expect(result.balanceAfter.toDecimalString()).toBe('1000.00');

        expect(tx.walletLedgerEntry.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              direction: 'DEBIT',
              status: LedgerEntryStatus.PENDING,
              amount: 50_000n,
              balanceBefore: 100_000n,
              balanceAfter: 100_000n,
            }) as unknown,
          }),
        );

        // Only the lock moves; `balance` is untouched.
        const update = tx.wallet.update.mock.calls[0]![0] as { data: Record<string, unknown> };
        expect(update.data.lockedBalance).toEqual({ increment: 50_000n });
        expect(update.data.balance).toBeUndefined();
      });

      it('counts existing holds as unavailable', async () => {
        // ₦1,000 balance with ₦800 already held leaves ₦200 spendable, so a
        // second ₦500 withdrawal must fail rather than double-reserve.
        const { db } = buildHoldDb({ balance: 100_000n, lockedBalance: 80_000n });
        const service = new WalletService(db, logger, metrics);

        await expect(
          inTenant(() =>
            service.hold({
              userId: USER_ID,
              amount: Money.fromNaira('500'),
              type: LedgerEntryType.WITHDRAWAL,
              reference: 'PAY-2',
            }),
          ),
        ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_BALANCE });
      });

      it('is idempotent on the reference', async () => {
        const { db, tx } = buildHoldDb({ heldEntry: heldEntry() });
        const service = new WalletService(db, logger, metrics);

        const result = await inTenant(() =>
          service.hold({
            userId: USER_ID,
            amount: Money.fromNaira('500'),
            type: LedgerEntryType.WITHDRAWAL,
            reference: 'PAY-1',
          }),
        );

        // A resubmitted withdrawal form must not reserve the funds twice.
        expect(result.duplicate).toBe(true);
        expect(tx.walletLedgerEntry.create).not.toHaveBeenCalled();
        expect(tx.wallet.update).not.toHaveBeenCalled();
      });
    });

    describe('settle', () => {
      it('debits the balance and clears the lock', async () => {
        const { db, tx } = buildHoldDb({
          balance: 100_000n,
          lockedBalance: 50_000n,
          heldEntry: heldEntry(),
        });
        const service = new WalletService(db, logger, metrics);

        const result = await inTenant(() => service.settle('PAY-1'));

        expect(result.balanceBefore.toDecimalString()).toBe('1000.00');
        expect(result.balanceAfter.toDecimalString()).toBe('500.00');

        const update = tx.wallet.update.mock.calls[0]![0] as { data: Record<string, unknown> };
        expect(update.data.balance).toBe(50_000n);
        expect(update.data.lockedBalance).toEqual({ decrement: 50_000n });
      });

      it('recomputes the balance at settle time, not from the hold', async () => {
        // A credit landed between the hold and its settlement: the hold recorded
        // ₦1,000, but the wallet now holds ₦1,500. Reusing the stale figure would
        // write a balance that never existed.
        const { db } = buildHoldDb({
          balance: 150_000n,
          lockedBalance: 50_000n,
          heldEntry: heldEntry(),
        });
        const service = new WalletService(db, logger, metrics);

        const result = await inTenant(() => service.settle('PAY-1'));

        expect(result.balanceBefore.toDecimalString()).toBe('1500.00');
        expect(result.balanceAfter.toDecimalString()).toBe('1000.00');
      });

      it('is idempotent when the hold is already settled', async () => {
        const { db, tx } = buildHoldDb({
          heldEntry: heldEntry({ status: LedgerEntryStatus.COMPLETED }),
        });
        const service = new WalletService(db, logger, metrics);

        const result = await inTenant(() => service.settle('PAY-1'));

        // A redelivered webhook must not debit a second time.
        expect(result.duplicate).toBe(true);
        expect(tx.wallet.update).not.toHaveBeenCalled();
      });

      it('refuses to settle a hold that was already released', async () => {
        const { db, tx } = buildHoldDb({
          heldEntry: heldEntry({ status: LedgerEntryStatus.FAILED }),
        });
        const service = new WalletService(db, logger, metrics);

        // Both outcomes for one payout is a genuine conflict, not a replay.
        await expect(inTenant(() => service.settle('PAY-1'))).rejects.toMatchObject({
          code: ErrorCode.INVALID_STATE_TRANSITION,
        });
        expect(tx.wallet.update).not.toHaveBeenCalled();
      });

      it('refuses to close a hold larger than the recorded lock', async () => {
        // Locked accounting that does not add up means the arithmetic is no
        // longer trustworthy; clamping would understate what is spendable.
        const { db } = buildHoldDb({
          balance: 100_000n,
          lockedBalance: 10_000n,
          heldEntry: heldEntry({ amount: 50_000n }),
        });
        const service = new WalletService(db, logger, metrics);

        await expect(inTenant(() => service.settle('PAY-1'))).rejects.toMatchObject({
          code: ErrorCode.INVALID_STATE_TRANSITION,
        });
      });
    });

    describe('release', () => {
      it('returns the funds without changing the balance', async () => {
        const { db, tx } = buildHoldDb({
          balance: 100_000n,
          lockedBalance: 50_000n,
          heldEntry: heldEntry(),
        });
        const service = new WalletService(db, logger, metrics);

        const result = await inTenant(() => service.release('PAY-1', 'Bank rejected'));

        // The money never left, so the balance is unchanged — only the reservation goes.
        expect(result.balanceAfter.toDecimalString()).toBe('1000.00');

        const update = tx.wallet.update.mock.calls[0]![0] as { data: Record<string, unknown> };
        expect(update.data.lockedBalance).toEqual({ decrement: 50_000n });
        expect(update.data.balance).toBeUndefined();
        expect(update.data.totalDebited).toBeUndefined();
      });

      it('records the failure reason on the entry', async () => {
        const { db, tx } = buildHoldDb({
          lockedBalance: 50_000n,
          heldEntry: heldEntry(),
        });
        const service = new WalletService(db, logger, metrics);

        await inTenant(() => service.release('PAY-1', 'Account closed'));

        expect(tx.walletLedgerEntry.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: LedgerEntryStatus.FAILED,
              metadata: { failureReason: 'Account closed' },
            }) as unknown,
          }),
        );
      });

      it('raises when no hold exists for the reference', async () => {
        const { db } = buildHoldDb({ heldEntry: null });
        const service = new WalletService(db, logger, metrics);

        await expect(inTenant(() => service.release('PAY-missing'))).rejects.toMatchObject({
          code: ErrorCode.RESOURCE_NOT_FOUND,
        });
      });
    });
  });
});
