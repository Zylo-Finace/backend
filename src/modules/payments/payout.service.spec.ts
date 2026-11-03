import { PayoutProviderName, PayoutStatus, WebhookEventStatus } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../../core/errors/app.exception';
import { ErrorCode } from '../../core/errors/error-code.enum';
import { Money } from '../../core/money/money';
import type { CacheService } from '../../infrastructure/cache/cache.service';
import type {
  ExtendedPrismaClient,
  PrismaService,
} from '../../infrastructure/database/prisma.service';
import type { MetricsService } from '../../infrastructure/observability/metrics.service';
import type { WalletService } from '../wallet/wallet.service';
import {
  type NormalisedPayoutEvent,
  PayoutEventStatus,
  type PayoutProvider,
} from './payout-provider.interface';
import { PayoutService } from './payout.service';

const TENANT_ID = '0195f2a0-0000-7000-8000-000000000001';
const USER_ID = '0195f2a0-0000-7000-8000-000000000002';
const PAYOUT_ID = '0195f2a0-0000-7000-8000-000000000003';

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const metrics = { messagesTotal: { inc: jest.fn() } } as unknown as MetricsService;

const config = {
  payouts: { provider: 'falconpay', minAmountNaira: 100, maxAmountNaira: 1_000_000 },
} as AppConfig;

/** A cache that always misses, so the loader runs every time. */
const cache = {
  keys: { global: (...parts: unknown[]) => parts.join(':') },
  remember: <T>(_key: string, _ttl: number, loader: () => Promise<T>) => loader(),
} as unknown as CacheService;

const BANKS = [
  { name: 'GTBank', code: '058' },
  { name: 'Access Bank', code: '044' },
];

function buildHarness(
  options: {
    existingPayout?: unknown;
    initiate?: jest.Mock;
    payoutRow?: Record<string, unknown>;
  } = {},
) {
  const payoutRow = {
    id: PAYOUT_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    reference: 'PAY-20260806-abc',
    status: PayoutStatus.PENDING,
    ...options.payoutRow,
  };

  const db = {
    payout: {
      findFirst: jest.fn().mockResolvedValue(options.existingPayout ?? null),
      create: jest.fn().mockResolvedValue(payoutRow),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...payoutRow, ...args.data }),
      ),
    },
  } as unknown as ExtendedPrismaClient;

  const prisma = {
    payout: { findFirst: jest.fn().mockResolvedValue(payoutRow) },
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  const wallet = {
    hold: jest.fn().mockResolvedValue({ entryId: 'entry-1', duplicate: false }),
    settle: jest.fn().mockResolvedValue({ entryId: 'entry-1', duplicate: false }),
    release: jest.fn().mockResolvedValue({ entryId: 'entry-1', duplicate: false }),
  } as unknown as WalletService;

  const provider = {
    name: PayoutProviderName.FALCONPAY,
    listBanks: jest.fn().mockResolvedValue(BANKS),
    resolveAccount: jest.fn().mockResolvedValue({
      accountNumber: '0123456789',
      bankCode: '058',
      accountName: 'JOHN DOE',
    }),
    initiateTransfer:
      options.initiate ??
      jest.fn().mockResolvedValue({ providerReference: 'FalconPay-XYZ', raw: {} }),
    verifySignature: jest.fn().mockReturnValue(true),
    parseEvent: jest.fn(),
  } as unknown as PayoutProvider;

  const service = new PayoutService(db, prisma, wallet, provider, config, cache, logger, metrics);

  return { service, db, prisma, wallet, provider };
}

const inTenant = <T>(fn: () => Promise<T>) => RequestContext.run({ tenantId: TENANT_ID }, fn);

const request = {
  userId: USER_ID,
  amount: Money.fromNaira('5000'),
  bankCode: '058',
  accountNumber: '0123456789',
  idempotencyKey: 'client-key-0001',
};

describe('PayoutService', () => {
  afterEach(() => jest.clearAllMocks());

  // ===========================================================================
  //  Ordering — the funds must be reserved before anything is sent
  // ===========================================================================

  describe('requestPayout', () => {
    it('holds the funds before calling the provider', async () => {
      const { service, wallet, provider } = buildHarness();

      await inTenant(() => service.requestPayout(request));

      // Calling the provider first leaves a window in which a second request
      // sees the full balance and withdraws the same money again.
      const holdOrder = (wallet.hold as jest.Mock).mock.invocationCallOrder[0]!;
      const sendOrder = (provider.initiateTransfer as jest.Mock).mock.invocationCallOrder[0]!;
      expect(holdOrder).toBeLessThan(sendOrder);
    });

    it('sends the bank-resolved name, not anything the customer typed', async () => {
      const { service, provider } = buildHarness();

      await inTenant(() => service.requestPayout(request));

      expect(provider.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ accountName: 'JOHN DOE' }),
      );
    });

    it('records the payout before submitting it', async () => {
      const { service, db, provider } = buildHarness();

      await inTenant(() => service.requestPayout(request));

      // A provider transfer with no local row is unrecoverable; the reverse is not.
      const createOrder = (db.payout.create as jest.Mock).mock.invocationCallOrder[0]!;
      const sendOrder = (provider.initiateTransfer as jest.Mock).mock.invocationCallOrder[0]!;
      expect(createOrder).toBeLessThan(sendOrder);
    });

    it('moves to PROCESSING, never to COMPLETED, on acceptance', async () => {
      const { service, db } = buildHarness();

      await inTenant(() => service.requestPayout(request));

      // A 202 means queued. Marking it complete here would tell the customer
      // money arrived that has not left yet.
      expect(db.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PayoutStatus.PROCESSING }) as unknown,
        }),
      );
    });

    it('returns the original payout for a repeated idempotency key', async () => {
      const existing = { id: PAYOUT_ID, status: PayoutStatus.PROCESSING };
      const { service, wallet, provider } = buildHarness({ existingPayout: existing });

      const result = await inTenant(() => service.requestPayout(request));

      expect(result).toBe(existing);
      // Neither a second hold nor a second transfer.
      expect(wallet.hold).not.toHaveBeenCalled();
      expect(provider.initiateTransfer).not.toHaveBeenCalled();
    });

    it('derives the same reference from the same idempotency key', async () => {
      const { service, db } = buildHarness();
      const { service: second, db: secondDb } = buildHarness();

      await inTenant(() => service.requestPayout(request));
      await inTenant(() => second.requestPayout(request));

      const first = (db.payout.create as jest.Mock).mock.calls[0]![0] as {
        data: { reference: string };
      };
      const repeat = (secondDb.payout.create as jest.Mock).mock.calls[0]![0] as {
        data: { reference: string };
      };
      expect(first.data.reference).toBe(repeat.data.reference);
      // The client's raw key must not leak into the reference.
      expect(first.data.reference).not.toContain('client-key-0001');
    });

    it('rejects an unsupported bank before touching the balance', async () => {
      const { service, wallet } = buildHarness();

      await expect(
        inTenant(() => service.requestPayout({ ...request, bankCode: '999' })),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
      expect(wallet.hold).not.toHaveBeenCalled();
    });

    it.each([
      ['below the minimum', '50'],
      ['above the maximum', '2000000'],
      ['not whole naira', '5000.50'],
    ])('rejects an amount %s', async (_label, amount) => {
      const { service, wallet } = buildHarness();

      await expect(
        inTenant(() => service.requestPayout({ ...request, amount: Money.fromNaira(amount) })),
      ).rejects.toMatchObject({ code: ErrorCode.PAYOUT_AMOUNT_NOT_ALLOWED });
      expect(wallet.hold).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  //  Failure classification — where getting it wrong costs real money
  // ===========================================================================

  describe('when submission fails', () => {
    const failWith = (code: ErrorCode) =>
      jest.fn().mockRejectedValue(new AppException(code, { message: 'nope' }));

    it('keeps the hold and parks for review when the outcome is unknown', async () => {
      const { service, db, wallet } = buildHarness({
        initiate: failWith(ErrorCode.PAYOUT_UNKNOWN_OUTCOME),
      });

      await expect(inTenant(() => service.requestPayout(request))).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_UNKNOWN_OUTCOME,
      });

      // The transfer may have gone through. Releasing on a guess is how the
      // same money gets paid out twice.
      expect(wallet.release).not.toHaveBeenCalled();
      expect(db.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PayoutStatus.REQUIRES_REVIEW }) as unknown,
        }),
      );
    });

    it('releases the hold only on a definite rejection', async () => {
      const { service, db, wallet } = buildHarness({
        initiate: failWith(ErrorCode.PAYOUT_REJECTED),
      });

      await expect(inTenant(() => service.requestPayout(request))).rejects.toMatchObject({
        code: ErrorCode.PAYOUT_REJECTED,
      });

      // The provider refused it, so no money moved and the customer keeps it.
      expect(wallet.release).toHaveBeenCalledWith('PAY-20260806-abc', expect.any(String));
      expect(db.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PayoutStatus.FAILED }) as unknown,
        }),
      );
    });

    it('treats a duplicate reference as already in flight', async () => {
      const { service, db, wallet } = buildHarness({
        initiate: failWith(ErrorCode.PAYOUT_DUPLICATE_REFERENCE),
      });

      // The provider already has this transfer — it is not an error to unwind.
      const result = await inTenant(() => service.requestPayout(request));

      expect(result.status).toBe(PayoutStatus.PROCESSING);
      expect(wallet.release).not.toHaveBeenCalled();
      expect(db.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PayoutStatus.PROCESSING }) as unknown,
        }),
      );
    });
  });

  // ===========================================================================
  //  Webhooks
  // ===========================================================================

  describe('handleWebhook', () => {
    const event = (overrides: Partial<NormalisedPayoutEvent> = {}): NormalisedPayoutEvent => ({
      reference: 'PAY-20260806-abc',
      status: PayoutEventStatus.Completed,
      rawEventType: 'payout.completed',
      providerReference: 'FalconPay-XYZ',
      ...overrides,
    });

    it('settles the hold on a completed event', async () => {
      const { service, wallet, db } = buildHarness({
        payoutRow: { status: PayoutStatus.PROCESSING },
      });

      await service.handleWebhook({}, 'sig', event());

      expect(wallet.settle).toHaveBeenCalledWith('PAY-20260806-abc');
      expect(db.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PayoutStatus.COMPLETED }) as unknown,
        }),
      );
    });

    it('releases the hold on a failed event', async () => {
      const { service, wallet, db } = buildHarness({
        payoutRow: { status: PayoutStatus.PROCESSING },
      });

      await service.handleWebhook(
        {},
        'sig',
        event({ status: PayoutEventStatus.Failed, message: 'Account closed' }),
      );

      expect(wallet.release).toHaveBeenCalledWith('PAY-20260806-abc', 'Account closed');
      expect(db.payout.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PayoutStatus.FAILED }) as unknown,
        }),
      );
    });

    it('does not move money on a processing event', async () => {
      const { service, wallet } = buildHarness({ payoutRow: { status: PayoutStatus.PENDING } });

      await service.handleWebhook({}, 'sig', event({ status: PayoutEventStatus.Processing }));

      expect(wallet.settle).not.toHaveBeenCalled();
      expect(wallet.release).not.toHaveBeenCalled();
    });

    it('does not walk a completed payout back to processing', async () => {
      // Events can arrive out of order; a late `processing` must not undo a
      // settlement that already happened.
      const { service, db } = buildHarness({ payoutRow: { status: PayoutStatus.COMPLETED } });

      await service.handleWebhook({}, 'sig', event({ status: PayoutEventStatus.Processing }));

      const update = (db.payout.update as jest.Mock).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(update.data.status).toBeUndefined();
    });

    it('deduplicates on reference and status together', async () => {
      // Keying on the reference alone would discard the `completed` event that
      // legitimately follows a `processing` one for the same payout.
      const { service, prisma } = buildHarness();

      await service.handleWebhook({}, 'sig', event());

      expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerEventId: 'PAY-20260806-abc:completed',
          }) as unknown,
        }),
      );
    });

    it('acknowledges a redelivered event without reprocessing it', async () => {
      const { service, wallet, prisma } = buildHarness();
      (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue({
        id: 'evt-1',
        status: WebhookEventStatus.PROCESSED,
      });

      const outcome = await service.handleWebhook({}, 'sig', event());

      expect(outcome.duplicate).toBe(true);
      expect(wallet.settle).not.toHaveBeenCalled();
    });

    it('ignores an event carrying no actionable status', async () => {
      const { service, wallet } = buildHarness();

      const outcome = await service.handleWebhook(
        {},
        'sig',
        event({ status: PayoutEventStatus.Ignored }),
      );

      expect(outcome.status).toBe(WebhookEventStatus.IGNORED);
      expect(wallet.settle).not.toHaveBeenCalled();
    });

    it('raises when no payout matches the reference', async () => {
      const { service, prisma } = buildHarness();
      (prisma.payout.findFirst as jest.Mock).mockResolvedValue(null);

      // Either a reference collision or a lost write — both need a human, and
      // the 5xx makes the provider retry rather than drop the event.
      await expect(service.handleWebhook({}, 'sig', event())).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_NOT_FOUND,
      });
    });
  });
});
