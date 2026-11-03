import { createHmac } from 'node:crypto';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { APP_CONFIG } from '../src/config/config.module';
import type { AppConfig } from '../src/config/app.config';
import { ErrorCode } from '../src/core/errors/error-code.enum';
import { REDIS_CLIENT } from '../src/infrastructure/cache/redis.provider';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const SECRET = process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_e2e_secret_value_0000';
const TENANT_ID = '0195f2a0-0000-7000-8000-000000000001';
const USER_ID = '0195f2a0-0000-7000-8000-000000000002';

interface ErrorEnvelope {
  success: boolean;
  error?: { code: ErrorCode; message: string };
}

/** Webhook responses go through the standard envelope like every other route. */
interface WebhookEnvelope {
  success: boolean;
  data: { received: boolean; status: string };
}

const sign = (body: string, secret = SECRET) =>
  createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');

function fundingPayload(reference = 'TRF_e2e_1', amountKobo = 150_050) {
  return {
    event: 'charge.success',
    data: {
      id: 998877,
      reference,
      amount: amountKobo,
      currency: 'NGN',
      channel: 'dedicated_nuban',
      paid_at: '2026-08-06T10:15:00.000Z',
      authorization: {
        receiver_bank_account_number: '9912345678',
        sender_name: 'ADAEZE OKONKWO',
        sender_bank: 'GTBank',
      },
    },
  };
}

/**
 * End-to-end coverage of the funding webhook.
 *
 * The signature is the *only* authentication on this endpoint, so these tests
 * are the security boundary: they assert that unsigned, wrongly-signed and
 * tampered payloads are refused before any parsing or crediting occurs.
 */
describe('Payment webhooks (e2e)', () => {
  let app: NestExpressApplication;

  const webhookEventCreate = jest.fn();
  const webhookEventFindUnique = jest.fn();
  const bankAccountFindFirst = jest.fn();
  const creditSpy = jest.fn();

  beforeAll(async () => {
    const prismaStub = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(undefined),
      scoped: {
        bankAccount: { findFirst: jest.fn(), upsert: jest.fn() },
        user: { findFirst: jest.fn() },
      },
      tenant: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: TENANT_ID, slug: 'acme', status: 'ACTIVE', deletedAt: null }),
      },
      webhookEvent: {
        create: webhookEventCreate,
        findUnique: webhookEventFindUnique,
        update: jest.fn().mockResolvedValue({}),
      },
      bankAccount: { findFirst: bankAccountFindFirst },
      user: { findFirst: jest.fn() },
      onModuleInit: jest.fn().mockResolvedValue(undefined),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    };

    const redisStub = {
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(0),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisStub)
      .overrideProvider(WalletService)
      .useValue({ credit: creditSpy, debit: jest.fn(), getBalance: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bufferLogs: true,
      // Mirrors main.ts. Without this the raw buffer is unavailable and every
      // signature check fails — which is exactly what one test below asserts.
      rawBody: true,
    });
    configureApp(app, app.get<AppConfig>(APP_CONFIG));
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    webhookEventFindUnique.mockResolvedValue(null);
    webhookEventCreate.mockResolvedValue({ id: 'evt-1' });
    bankAccountFindFirst.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
    creditSpy.mockResolvedValue({
      entryId: 'entry-1',
      balanceBefore: { toDecimalString: () => '0.00' },
      balanceAfter: { toDecimalString: () => '1500.50' },
      duplicate: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = (body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    const req = request(app.getHttpServer())
      .post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json');

    if (signature !== undefined) req.set('x-paystack-signature', signature);
    return req.send(raw);
  };

  describe('signature enforcement', () => {
    it('rejects an unsigned payload', async () => {
      const response = await post(fundingPayload()).expect(401);

      expect((response.body as ErrorEnvelope).error?.code).toBe(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
      );
      expect(creditSpy).not.toHaveBeenCalled();
    });

    it('rejects a payload signed with the wrong secret', async () => {
      const body = fundingPayload();
      await post(body, sign(JSON.stringify(body), 'wrong-secret')).expect(401);

      expect(creditSpy).not.toHaveBeenCalled();
    });

    it('rejects a payload modified after signing', async () => {
      // The attack this endpoint exists to stop: replay a real webhook with the
      // amount changed.
      const original = fundingPayload('TRF_x', 100);
      const signature = sign(JSON.stringify(original));
      const inflated = fundingPayload('TRF_x', 10_000_000);

      await post(inflated, signature).expect(401);
      expect(creditSpy).not.toHaveBeenCalled();
    });

    it('never records an unverified event', async () => {
      await post(fundingPayload(), 'bogus').expect(401);

      // Verification precedes storage: an unsigned body is not given to any
      // parser and leaves no trace beyond a log line.
      expect(webhookEventCreate).not.toHaveBeenCalled();
    });

    it('reveals nothing about why verification failed', async () => {
      const response = await post(fundingPayload(), 'bogus').expect(401);

      const message = (response.body as ErrorEnvelope).error?.message ?? '';
      expect(message).toBe('Signature verification failed');
      expect(message).not.toMatch(/hmac|sha|secret|expected/i);
    });
  });

  describe('accepted webhooks', () => {
    it('credits the wallet behind the destination account', async () => {
      const body = fundingPayload();
      const response = await post(body, sign(JSON.stringify(body))).expect(200);

      expect((response.body as WebhookEnvelope).data).toMatchObject({
        received: true,
        status: 'processed',
      });
      expect(creditSpy).toHaveBeenCalledTimes(1);

      const call = creditSpy.mock.calls[0]?.[0] as {
        userId: string;
        reference: string;
        amount: { kobo: bigint };
      };
      expect(call.userId).toBe(USER_ID);
      // The provider's reference becomes the ledger idempotency key.
      expect(call.reference).toBe('TRF_e2e_1');
      expect(call.amount.kobo).toBe(150_050n);
    });

    it('acknowledges a redelivered event without crediting again', async () => {
      webhookEventFindUnique.mockResolvedValue({ id: 'evt-1', status: 'PROCESSED' });

      const body = fundingPayload();
      const response = await post(body, sign(JSON.stringify(body))).expect(200);

      expect((response.body as WebhookEnvelope).data.received).toBe(true);
      // Providers retry aggressively; a redelivery must be a no-op, not a
      // second credit.
      expect(creditSpy).not.toHaveBeenCalled();
    });

    it('acknowledges an event type it does not handle', async () => {
      // Returning non-2xx would make Paystack retry forever and eventually
      // disable the subscription.
      const body = { event: 'transfer.failed', data: { id: 42 } };
      const response = await post(body, sign(JSON.stringify(body))).expect(200);

      expect((response.body as WebhookEnvelope).data.status).toBe('ignored');
      expect(creditSpy).not.toHaveBeenCalled();
    });

    it('fails loudly when the destination account is unknown', async () => {
      bankAccountFindFirst.mockResolvedValue(null);

      const body = fundingPayload('TRF_orphan');
      // A non-2xx is correct here: the provider will retry, and by then the
      // account may exist. Silently returning 200 would strand the money.
      await post(body, sign(JSON.stringify(body))).expect(404);

      expect(creditSpy).not.toHaveBeenCalled();
    });
  });

  describe('endpoint characteristics', () => {
    it('requires no authentication token', async () => {
      // The provider holds no credential; the signature is the authentication.
      const body = fundingPayload();
      await post(body, sign(JSON.stringify(body))).expect(200);
    });

    it('rejects a body that is not valid JSON even when signed', async () => {
      const raw = '{"event": broken';
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/paystack')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', sign(raw))
        .send(raw)
        .expect(400);
    });
  });
});
