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
import { InboundService } from '../src/modules/whatsapp/inbound.service';

const APP_SECRET = process.env.META_APP_SECRET ?? 'e2e-meta-app-secret';
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN ?? 'e2e-meta-verify-token';

interface ErrorEnvelope {
  success: boolean;
  error?: { code: ErrorCode; message: string };
}

const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;

const messageWebhook = () => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '2348000000000', phone_number_id: 'META_PN' },
            contacts: [{ profile: { name: 'Adaeze' }, wa_id: '2348012345678' }],
            messages: [
              {
                from: '2348012345678',
                id: 'wamid.E2E1',
                timestamp: '1786000000',
                type: 'text',
                text: { body: 'balance' },
              },
            ],
          },
        },
      ],
    },
  ],
});

/**
 * End-to-end coverage of Meta's webhook contract.
 *
 * Both halves are dictated by Meta and both are easy to get subtly wrong: the
 * GET handshake must echo a bare string, and the POST is authenticated solely by
 * an HMAC over the raw bytes.
 */
describe('WhatsApp webhook (e2e)', () => {
  let app: NestExpressApplication;
  const ingest = jest.fn();

  beforeAll(async () => {
    const prismaStub = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(undefined),
      scoped: {},
      tenant: { findFirst: jest.fn().mockResolvedValue(null) },
      onModuleInit: jest.fn().mockResolvedValue(undefined),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    };

    const redisStub = {
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisStub)
      .overrideProvider(InboundService)
      .useValue({ ingest })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bufferLogs: true,
      rawBody: true,
    });
    configureApp(app, app.get<AppConfig>(APP_CONFIG));
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    ingest.mockResolvedValue({
      messagesStored: 1,
      messagesDuplicate: 0,
      statusesApplied: 0,
      unroutable: 0,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  describe('subscription handshake (GET)', () => {
    it('echoes the challenge as a bare string', async () => {
      const response = await api()
        .get('/api/v1/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        })
        .expect(200);

      // Meta compares the body byte-for-byte. Our JSON envelope here would fail
      // verification and the subscription would never activate.
      expect(response.text).toBe('1158201444');
      expect(response.body).not.toHaveProperty('success');
    });

    it('rejects an incorrect verify token', async () => {
      const response = await api()
        .get('/api/v1/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': '123',
        })
        .expect(403);

      expect((response.body as ErrorEnvelope).error?.code).toBe(
        ErrorCode.WEBHOOK_VERIFICATION_FAILED,
      );
    });

    it.each([
      [
        'wrong mode',
        { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' },
      ],
      ['no challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }],
      ['no token', { 'hub.mode': 'subscribe', 'hub.challenge': '1' }],
      ['nothing', {}],
    ])('rejects a malformed handshake (%s)', async (_label, query) => {
      await api().get('/api/v1/webhooks/whatsapp').query(query).expect(403);
    });
  });

  describe('event delivery (POST)', () => {
    const post = (body: unknown, signature?: string) => {
      const raw = JSON.stringify(body);
      const req = api().post('/api/v1/webhooks/whatsapp').set('Content-Type', 'application/json');

      if (signature !== undefined) req.set('x-hub-signature-256', signature);
      return req.send(raw);
    };

    it('accepts and ingests a correctly signed batch', async () => {
      const body = messageWebhook();
      await post(body, sign(JSON.stringify(body))).expect(200);

      expect(ingest).toHaveBeenCalledTimes(1);
      const parsed = ingest.mock.calls[0]?.[0] as { messages: { wamid: string }[] };
      expect(parsed.messages[0]?.wamid).toBe('wamid.E2E1');
    });

    it('rejects an unsigned payload', async () => {
      const response = await post(messageWebhook()).expect(401);

      expect((response.body as ErrorEnvelope).error?.code).toBe(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
      );
      expect(ingest).not.toHaveBeenCalled();
    });

    it('rejects a payload signed with the wrong secret', async () => {
      const body = messageWebhook();
      await post(body, sign(JSON.stringify(body), 'not-the-secret')).expect(401);

      expect(ingest).not.toHaveBeenCalled();
    });

    it('rejects a payload altered after signing', async () => {
      const original = messageWebhook();
      const signature = sign(JSON.stringify(original));

      const altered = messageWebhook();
      altered.entry[0]!.changes[0]!.value.messages[0]!.text.body = 'transfer everything';

      await post(altered, signature).expect(401);
      expect(ingest).not.toHaveBeenCalled();
    });

    it('never parses an unverified body', async () => {
      await post(messageWebhook(), 'sha256=deadbeef').expect(401);
      expect(ingest).not.toHaveBeenCalled();
    });

    it('acknowledges a payload carrying no messages or statuses', async () => {
      // Meta sends account-level notifications we do not model. They must still
      // get a 2xx or Meta retries them indefinitely.
      const body = { object: 'whatsapp_business_account', entry: [] };
      await post(body, sign(JSON.stringify(body))).expect(200);

      expect(ingest).not.toHaveBeenCalled();
    });

    it('still returns 200 when individual messages fail to store', async () => {
      // A non-2xx makes Meta redeliver the ENTIRE batch, resending the messages
      // that already succeeded.
      ingest.mockResolvedValue({
        messagesStored: 0,
        messagesDuplicate: 0,
        statusesApplied: 0,
        unroutable: 1,
      });

      const body = messageWebhook();
      await post(body, sign(JSON.stringify(body))).expect(200);
    });

    it('requires no authentication token', async () => {
      const body = messageWebhook();
      await post(body, sign(JSON.stringify(body))).expect(200);
    });
  });
});
